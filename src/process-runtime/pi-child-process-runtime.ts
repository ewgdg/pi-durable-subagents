import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rmdir,
	writeFile,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import { AgentControlAdmissionBroker } from "../control/agent-control-admission.ts";
import {
	FramedAgentControlChannel,
	type ControlEvent,
} from "../control/agent-control-channel.ts";
import {
	agentControlProtocol,
	RuntimeSnapshotSchema,
} from "../control/agent-control-protocol.ts";
import { createPlatformControlListener } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import type { AgentRunLaunchConfiguration } from "../templates/agent-configuration.ts";
import {
	buildChildProcessEnvironment,
} from "./child-process-environment.ts";
import { ChildLaunchContractGuard } from "./child-launch-contract.ts";
import { materializeNewChildSystemPromptArtifact } from "./child-system-prompt-artifact.ts";
import { buildPiChildCliLaunch } from "./pi-child-cli-launch.ts";
import {
	dispatchParticipantRequestToOwner,
	type OwnerParticipantRequestHandlers,
} from "./remote-participant-control.ts";
import {
	spawnPtyTerminalProjection,
	type PtyExit,
	type PtyTerminalProjection,
	type TerminalProjectionFrame,
} from "./pty-terminal-projection.ts";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MILLISECONDS = 3_000;
/**
 * How long a viewer handoff waits for Pi's DEC 2026 frame bracket before showing
 * the child anyway. The bracket orders the first published frame; a child that is
 * paused in startup, blocked in a handler, or exiting never emits one, and a live
 * viewer must not be held on the previous screen forever. Pi repaints a shown TUI
 * within a frame or two, so this bound only ever fires for a child that cannot
 * repaint at all.
 */
const SCREEN_VIEW_FRAME_BOUND_MILLISECONDS = 1_000;
const SCREEN_VIEW_FRAME_TIMEOUT_DIAGNOSTIC =
	"child_screen_frame_timeout: the child screen handoff completed without a complete native frame";
const BRIDGE_EXTENSION_PATH = fileURLToPath(
	new URL("./child-runtime-bridge.ts", import.meta.url),
);
const INPUT_EXTENSION_PATH = fileURLToPath(
	new URL("./child-runtime-input.ts", import.meta.url),
);

export type PiChildRuntimeSnapshot = Static<typeof RuntimeSnapshotSchema>;
export type PiChildRuntimeReady = Readonly<{
	sessionId: string;
	mode: "tui";
	hasUI: true;
}>;
export type PiChildRuntimeEvent = ControlEvent<typeof agentControlProtocol>;
export type PiChildRuntimeChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

export type StartPiChildProcessRuntimeOptions = Readonly<{
	workflowId: string;
	agentId: string;
	launchContract?: ChildLaunchContractGuard;
	role: ChildProcessBootstrap["role"];
	expectedSessionId: string;
	sessionPath: string;
	configuration: AgentRunLaunchConfiguration;
	skillPaths: readonly string[];
	projectTrusted: boolean;
	agentDir?: string;
	ownerEnvironment?: NodeJS.ProcessEnv;
	runtimeDirectory?: string;
	columns?: number;
	rows?: number;
	startupTimeoutMilliseconds?: number;
	cliPath?: string;
	bridgeExtensionPath?: string;
	inputExtensionPath?: string;
	ownerRequestHandlers?:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">;
}>;

/** Standalone Owner-side host for one real Pi CLI/TUI process. */
export class PiChildProcessRuntime {
	readonly #projection: PtyTerminalProjection;
	readonly #admissionBroker: AgentControlAdmissionBroker<typeof agentControlProtocol>;
	readonly #eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	readonly #cleanup: () => Promise<void>;
	#cleanupPromise: Promise<void> | undefined;
	#shutdownPromise: Promise<PtyExit> | undefined;
	#exitResult: PtyExit | undefined;
	#exitObserved = false;
	#channelClosed = false;
	readonly #presentation: ChildProcessPresentation;

	readonly channel: PiChildRuntimeChannel;
	readonly ready: PiChildRuntimeReady;
	readonly snapshot: PiChildRuntimeSnapshot;
	readonly bootstrapPath: string;
	readonly exited: Promise<PtyExit>;

	private constructor(options: {
		presentation: ChildProcessPresentation;
		projection: PtyTerminalProjection;
		admissionBroker: AgentControlAdmissionBroker<typeof agentControlProtocol>;
		channel: PiChildRuntimeChannel;
		ready: PiChildRuntimeReady;
		snapshot: PiChildRuntimeSnapshot;
		bootstrapPath: string;
		artifactDirectory: string;
		systemPromptArtifactPath: string | undefined;
		eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	}) {
		this.#presentation = options.presentation;
		this.#projection = options.projection;
		this.#admissionBroker = options.admissionBroker;
		this.#eventHandlers = options.eventHandlers;
		this.channel = options.channel;
		this.ready = options.ready;
		this.snapshot = options.snapshot;
		this.bootstrapPath = options.bootstrapPath;
		const systemPromptArtifactPath = options.systemPromptArtifactPath;
		this.#cleanup = () => completeCleanup([
			() => this.channel.close().catch(() => undefined),
			() => unlinkIfExists(this.bootstrapPath),
			...(systemPromptArtifactPath === undefined
				? []
				: [() => unlinkIfExists(systemPromptArtifactPath)]),
			() => this.#admissionBroker.close().catch(() => undefined),
			() => this.#projection.dispose().catch(() => undefined),
			() => removeEmptyDirectory(options.artifactDirectory),
		]);
		this.exited = this.#projection.exited.then(async (exit) => {
			this.#exitObserved = true;
			this.#exitResult = exit;
			await this.#finalize();
			return exit;
		});
		this.channel.onClose(() => {
			this.#channelClosed = true;
			if (this.#exitObserved) return;
			const forceCleanup = setTimeout(() => {
				if (!this.#exitObserved) forceKillProjection(this.#projection);
			}, DEFAULT_SHUTDOWN_GRACE_MILLISECONDS);
			forceCleanup.unref();
		});
	}

	static async start(options: StartPiChildProcessRuntimeOptions): Promise<PiChildProcessRuntime> {
		return await (await this.launch(options)).ready();
	}

	static async launch(options: StartPiChildProcessRuntimeOptions): Promise<PiChildProcessLaunch> {
		await (options.launchContract ?? new ChildLaunchContractGuard()).assertCompatible();
		const listener = await createPlatformControlListener({
			workflowId: options.workflowId,
			...(options.runtimeDirectory === undefined
				? {}
				: { runtimeDirectory: options.runtimeDirectory }),
		});
		const admissionBroker = new AgentControlAdmissionBroker({
			listener,
			protocol: agentControlProtocol,
			workflowId: options.workflowId,
		});
		let artifactDirectory: string;
		try {
			artifactDirectory = await createRuntimeArtifactDirectory(options.runtimeDirectory);
		} catch (error) {
			await admissionBroker.close().catch(() => undefined);
			throw error;
		}
		// Control endpoints are opaque IPC descriptors. In particular, a Windows
		// named pipe is not a filesystem parent for bootstrap or prompt artifacts.
		const bootstrapPath = join(artifactDirectory, "bootstrap.json");
		const systemPromptArtifactCandidatePath = join(artifactDirectory, "system-prompt.md");
		let systemPromptArtifactPath: string | undefined;
		let projection: PtyTerminalProjection | undefined;
		let channel: PiChildRuntimeChannel | undefined;
		let cleanupPromise: Promise<void> | undefined;
		try {
			const bootstrap: ChildProcessBootstrap = {
				protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
				endpoint: listener.endpoint,
				connectionToken: randomBytes(32).toString("hex"),
				workflowId: requireIdentity("workflowId", options.workflowId),
				agentId: requireIdentity("agentId", options.agentId),
				role: options.role,
				ownerPresentation: options.ownerRequestHandlers !== undefined,
				// The child removes these names from its own runtime default surface.
				excludedTools: [...options.configuration.excludeTools],
				expectedSessionId: requireIdentity("expectedSessionId", options.expectedSessionId),
			};
			validateChildProcessBootstrap(bootstrap);
			if (options.configuration.systemPrompt !== undefined) {
				systemPromptArtifactPath = await materializeNewChildSystemPromptArtifact({
					path: systemPromptArtifactCandidatePath,
					body: options.configuration.systemPrompt.body,
				});
			}
			await writeFile(bootstrapPath, `${JSON.stringify(bootstrap)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			const bridgeExtensionPath = options.bridgeExtensionPath ?? BRIDGE_EXTENSION_PATH;
			const inputExtensionPath = options.inputExtensionPath ?? INPUT_EXTENSION_PATH;
			const childLaunch = buildPiChildCliLaunch({
				cliPath: options.cliPath ?? resolveInstalledPiCliPath(),
				sessionPath: options.sessionPath,
				configuration: options.configuration,
				skillPaths: options.skillPaths,
				bridgeExtensionPath,
				inputExtensionPath,
				...(systemPromptArtifactPath === undefined
					? {}
					: { systemPromptArtifactPath }),
				projectTrusted: options.projectTrusted,
			});
			const ownerEnvironment = options.ownerEnvironment ?? process.env;
			const resolvedAgentDir = options.agentDir ?? ownerEnvironment.PI_CODING_AGENT_DIR;
			if (!resolvedAgentDir) {
				throw new Error(
					"invalid_child_runtime: parent PI_CODING_AGENT_DIR is required",
				);
			}
			const environment = buildChildProcessEnvironment({
				ownerEnvironment,
				bootstrapPath,
				loadContextFiles: options.configuration.loadContextFiles,
				...(systemPromptArtifactPath === undefined
					? {}
					: {
						systemPromptMode: options.configuration.systemPrompt!.mode,
						systemPromptPath: systemPromptArtifactPath,
					}),
			});
			environment.PI_CODING_AGENT_DIR = resolvedAgentDir;
			// These describe the owned @xterm/headless PTY, not the Owner's terminal.
			// xterm.js accepts 24-bit RGB sequences, which xterm-256color alone does
			// not advertise to applications that use COLORTERM for capability detection.
			environment.TERM = "xterm-256color";
			environment.COLORTERM = "truecolor";
			const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
			let settleReady!: (ready: PiChildRuntimeReady) => void;
			let rejectReady!: (error: Error) => void;
			const bridgeReady = new Promise<PiChildRuntimeReady>((resolve, reject) => {
				settleReady = resolve;
				rejectReady = reject;
			});
			// Control can settle either deferred before startup reaches its matching
			// await. Own both rejections immediately; launch.ready() remains the caller's
			// authoritative failure and cleanup boundary.
			void bridgeReady.catch(() => undefined);
			let settleStartupComplete!: (snapshot: PiChildRuntimeSnapshot) => void;
			const startupComplete = new Promise<PiChildRuntimeSnapshot>((resolve) => {
				settleStartupComplete = resolve;
			});
			let rejectStartupFault!: (error: Error) => void;
			const startupFault = new Promise<never>((_resolve, reject) => {
				rejectStartupFault = reject;
			});
			void startupFault.catch(() => undefined);
			const admission = admissionBroker.admit(
				{
					agentId: bootstrap.agentId,
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				},
				(candidate) => {
					candidate.onRequest((request) =>
						dispatchParticipantRequestToOwner(
							options.ownerRequestHandlers,
							request,
							{
								waitProgress: (toolCallId, progress) => {
									void candidate.sendEvent("coordination.wait.progress", {
										toolCallId,
										progress,
									}).catch(() => undefined);
								},
							},
						)
					);
					const removePresentationChangeHandler = options.ownerRequestHandlers
						?.presentation.addChangeHandler?.((snapshot) => {
							void candidate.sendEvent("presentation.agents.changed", {
								...snapshot,
								live: [...snapshot.live],
								dormant: [...snapshot.dormant],
								humanAttention: [...snapshot.humanAttention],
								operationalAttention: [...snapshot.operationalAttention],
							}).catch(() => undefined);
						}) ?? (() => undefined);
					candidate.onEvent((event) => {
						if (event.event === "runtime.ready") settleReady(event.payload);
						if (event.event === "runtime.startupComplete") settleStartupComplete(event.payload);
						if (event.event === "runtime.fault") {
							rejectStartupFault(new Error(
								`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
							));
						}
						for (const handler of eventHandlers) handler(event);
					});
					candidate.onClose((cause) => {
						removePresentationChangeHandler();
						rejectReady(cause);
						rejectStartupFault(cause);
					});
				},
			);
			void admission.catch(() => undefined);
			projection = spawnPtyTerminalProjection({
				file: childLaunch.command,
				arguments: childLaunch.arguments,
				cwd: childLaunch.cwd,
				environment,
				columns: options.columns ?? DEFAULT_COLUMNS,
				rows: options.rows ?? DEFAULT_ROWS,
			});
			const exactProjection = projection;
			const exactSystemPromptArtifactPath = systemPromptArtifactPath;
			const cleanup = () => {
				cleanupPromise ??= completeCleanup([
					() => channel?.close().catch(() => undefined) ?? Promise.resolve(),
					() => {
						forceKillProjection(exactProjection);
						return Promise.resolve();
					},
					() => exactProjection.dispose().catch(() => undefined),
					() => unlinkIfExists(bootstrapPath),
					...(exactSystemPromptArtifactPath === undefined
						? []
						: [() => unlinkIfExists(exactSystemPromptArtifactPath)]),
					() => admissionBroker.close().catch(() => undefined),
					() => removeEmptyDirectory(artifactDirectory),
				]);
				return cleanupPromise;
			};
			const timeoutMilliseconds = options.startupTimeoutMilliseconds
				?? DEFAULT_STARTUP_TIMEOUT_MILLISECONDS;
			return new PiChildProcessLaunch({
				projection: exactProjection,
				bootstrapPath,
				eventHandlers,
				cleanup,
				preparePresentation: async (cancellation) => {
					try {
						channel = await raceStartup(
							Promise.race([admission, startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"control admission",
							cancellation,
						);
						const readyPayload = await raceStartup(
							Promise.race([bridgeReady, startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"runtime.ready",
							cancellation,
						);
						if (readyPayload.sessionId !== bootstrap.expectedSessionId) {
							throw new Error(
								`child_runtime_ready_mismatch: expected session ${bootstrap.expectedSessionId}, received ${readyPayload.sessionId}`,
							);
						}
						// Presentation must be usable while inherited startup handlers await
						// dialogs. Only the later startup-completion snapshot admits Agent work.
						await exactProjection.enterNativeTerminalMode();
						await raceStartup(
							Promise.race([channel.request("presentation.setVisible", { visible: false }), startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"hidden presentation",
							cancellation,
						);
						return new ChildProcessPresentation(exactProjection, channel);
					} catch (error) {
						throw await withTerminalDiagnostic(error, exactProjection);
					}
				},
				initialize: async (presentation, cancellation) => {
					try {
						const snapshot = await raceStartup(
							Promise.race([startupComplete, startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"startup completion snapshot",
							cancellation,
						);
						await assertRuntimeSnapshot(
							snapshot,
							options.configuration,
							options.skillPaths,
							options.projectTrusted,
							bootstrap.expectedSessionId,
							options.sessionPath,
							exactSystemPromptArtifactPath,
						);
						return new PiChildProcessRuntime({
							presentation,
							projection: exactProjection,
							admissionBroker,
							channel: presentation.channel,
							ready: await bridgeReady,
							snapshot,
							bootstrapPath,
							artifactDirectory,
							systemPromptArtifactPath: exactSystemPromptArtifactPath,
							eventHandlers,
						});
					} catch (error) {
						throw await withTerminalDiagnostic(error, exactProjection);
					}
				},
			});
		} catch (error) {
			try {
				await completeCleanup([
					() => channel?.close().catch(() => undefined) ?? Promise.resolve(),
					() => {
						if (projection) forceKillProjection(projection);
						return Promise.resolve();
					},
					() => projection?.dispose().catch(() => undefined) ?? Promise.resolve(),
					() => unlinkIfExists(bootstrapPath),
					() => unlinkIfExists(systemPromptArtifactCandidatePath),
					() => admissionBroker.close().catch(() => undefined),
					() => removeEmptyDirectory(artifactDirectory),
				]);
			} catch (cleanupError) {
				throw new AggregateError(
					[asError(error), asError(cleanupError)],
					"child_runtime_startup_cleanup_failed",
				);
			}
			throw error;
		}
	}

	get pid(): number {
		return this.#projection.pid;
	}

	dimensions(): Readonly<{ columns: number; rows: number }> {
		return this.#projection.dimensions();
	}

	frame(): TerminalProjectionFrame {
		return this.#projection.frame();
	}

	addChangeHandler(handler: () => void): () => void {
		return this.#projection.addChangeHandler(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		return this.#projection.addFailureHandler(handler);
	}

	addOutputHandler(handler: (data: string) => void): () => void {
		return this.#projection.addOutputHandler(handler);
	}

	async beginPhysicalTerminalAttachment(
		handler: (data: string) => void,
	): Promise<() => void> {
		return this.#presentation.beginPhysicalTerminalAttachment(handler);
	}

	beginScreenView(): Promise<void> {
		return this.#presentation.beginScreenView();
	}

	screenViewDiagnostic(): string | undefined {
		return this.#presentation.screenViewDiagnostic();
	}

	hidePresentation(): Promise<void> {
		return this.#presentation.hidePresentation();
	}

	pauseOutput(): void {
		this.#projection.pauseOutput();
	}

	resumeOutput(): void {
		this.#projection.resumeOutput();
	}

	setPresentationVisible(visible: boolean): Promise<void> {
		return this.#presentation.setPresentationVisible(visible);
	}

	writeInput(data: string | Buffer): void {
		this.#projection.writeInput(data);
	}

	resize(columns: number, rows: number): void {
		this.#projection.resize(columns, rows);
	}

	drain(): Promise<void> {
		return this.#projection.drain();
	}

	onEvent(handler: (event: PiChildRuntimeEvent) => void): () => void {
		this.#eventHandlers.add(handler);
		return () => this.#eventHandlers.delete(handler);
	}

	shutdown(
		reason?: string,
		graceMilliseconds = DEFAULT_SHUTDOWN_GRACE_MILLISECONDS,
	): Promise<PtyExit> {
		this.#shutdownPromise ??= this.#shutdown(reason, graceMilliseconds);
		return this.#shutdownPromise;
	}

	async dispose(): Promise<void> {
		if (this.#exitResult) {
			await this.#finalize();
			return;
		}
		await this.shutdown("runtime disposed").catch(() => undefined);
		await this.#finalize();
	}

	async #shutdown(reason: string | undefined, graceMilliseconds: number): Promise<PtyExit> {
		if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds < 1) {
			throw new Error("invalid_child_runtime_shutdown_grace: expected a positive integer");
		}
		// The grace period bounds the complete exchange. A wedged child may keep the
		// Control request pending forever, before process-exit waiting even begins.
		const gracefulExit = await withTimeout((async () => {
			if (!this.#channelClosed) {
				await this.channel.request("runtime.shutdown", {
					...(reason === undefined ? {} : { reason }),
				}).catch(() => undefined);
			} else {
				// If structured control is already unavailable, the native command is the
				// last graceful path before the exact process is forcibly terminated.
				try {
					this.#projection.writeInput("/quit\r");
				} catch {
					// The exit may have won the race; the exact exited Promise settles below.
				}
			}
			return await this.exited;
		})(), graceMilliseconds);
		if (gracefulExit) return gracefulExit;
		forceKillProjection(this.#projection);
		return await this.exited;
	}

	#finalize(): Promise<void> {
		this.#cleanupPromise ??= this.#cleanup();
		return this.#cleanupPromise;
	}
}

type PiChildProcessLaunchState =
	| Readonly<{ kind: "pending" }>
	| Readonly<{ kind: "admitted"; runtime: PiChildProcessRuntime }>
	| Readonly<{ kind: "cancelled"; error: unknown }>
	| Readonly<{ kind: "failed" }>;

/** Real child PTY and exact admission settlement exposed before Runtime readiness. */
export class PiChildProcessLaunch {
	readonly #projection: PtyTerminalProjection;
	readonly #eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	readonly #cleanupInitialization: () => Promise<void>;
	readonly #readiness: Promise<PiChildProcessRuntime>;
	readonly #presentationReadiness: Promise<ChildProcessPresentation>;
	#presentation: ChildProcessPresentation | undefined;
	#rejectCancellation!: (error: unknown) => void;
	#state: PiChildProcessLaunchState = { kind: "pending" };
	#cleanupPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#disposed = false;
	readonly bootstrapPath: string;
	readonly exited: Promise<PtyExit>;

	constructor(options: {
		projection: PtyTerminalProjection;
		bootstrapPath: string;
		eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
		cleanup(): Promise<void>;
		preparePresentation(cancellation: Promise<never>): Promise<ChildProcessPresentation>;
		initialize(presentation: ChildProcessPresentation, cancellation: Promise<never>): Promise<PiChildProcessRuntime>;
	}) {
		this.#projection = options.projection;
		this.bootstrapPath = options.bootstrapPath;
		this.#eventHandlers = options.eventHandlers;
		this.#cleanupInitialization = options.cleanup;
		this.exited = options.projection.exited;
		const cancellation = new Promise<never>((_resolve, reject) => {
			this.#rejectCancellation = reject;
		});
		this.#presentationReadiness = options.preparePresentation(cancellation);
		void this.#presentationReadiness.then(
			(presentation) => { this.#presentation = presentation; },
			() => undefined,
		);
		this.#readiness = this.#presentationReadiness.then(
			presentation => options.initialize(presentation, cancellation),
		).then(
			(runtime) => {
				if (this.#state.kind !== "pending") {
					throw this.#state.kind === "cancelled"
						? this.#state.error
						: new Error("child_runtime_launch_not_pending");
				}
				this.#state = { kind: "admitted", runtime };
				return runtime;
			},
			async (error) => {
				const rejection = this.#state.kind === "cancelled"
					? this.#state.error
					: error;
				if (this.#state.kind === "pending") this.#state = { kind: "failed" };
				await this.#beginInitializationCleanup().catch(() => undefined);
				throw rejection;
			},
		);
		void this.#readiness.catch(() => undefined);
	}

	get pid(): number {
		return this.#projection.pid;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	dimensions(): Readonly<{ columns: number; rows: number }> {
		return this.#projection.dimensions();
	}

	frame(): TerminalProjectionFrame {
		return this.#projection.frame();
	}

	addChangeHandler(handler: () => void): () => void {
		return this.#projection.addChangeHandler(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		return this.#projection.addFailureHandler(handler);
	}

	addOutputHandler(handler: (data: string) => void): () => void {
		return this.#projection.addOutputHandler(handler);
	}

	async beginPhysicalTerminalAttachment(
		handler: (data: string) => void,
	): Promise<() => void> {
		return this.#presentationReadiness.then(presentation => presentation.beginPhysicalTerminalAttachment(handler));
	}

	beginScreenView(): Promise<void> {
		return this.#presentationReadiness.then(presentation => presentation.beginScreenView());
	}

	screenViewDiagnostic(): string | undefined {
		return this.#presentation?.screenViewDiagnostic();
	}

	hidePresentation(): Promise<void> {
		return this.#presentationReadiness.then(presentation => presentation.hidePresentation());
	}

	pauseOutput(): void {
		this.#projection.pauseOutput();
	}

	resumeOutput(): void {
		this.#projection.resumeOutput();
	}

	setPresentationVisible(visible: boolean): Promise<void> {
		return this.#presentationReadiness.then(
			(presentation) => presentation.setPresentationVisible(visible),
		);
	}

	writeInput(data: string | Buffer): void {
		this.#projection.writeInput(data);
	}

	resize(columns: number, rows: number): void {
		this.#projection.resize(columns, rows);
	}

	drain(): Promise<void> {
		return this.#projection.drain();
	}

	onEvent(handler: (event: PiChildRuntimeEvent) => void): () => void {
		this.#eventHandlers.add(handler);
		return () => this.#eventHandlers.delete(handler);
	}

	ready(): Promise<PiChildProcessRuntime> {
		return this.#readiness;
	}

	cancelInitialization(error: unknown): Promise<void> | undefined {
		if (this.#state.kind !== "pending") return undefined;
		this.#state = { kind: "cancelled", error };
		const cleanup = this.#beginInitializationCleanup();
		this.#rejectCancellation(error);
		return cleanup;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#dispose();
		return this.#disposePromise;
	}

	#beginInitializationCleanup(): Promise<void> {
		this.#cleanupPromise ??= this.#cleanupInitialization().finally(() => {
			this.#disposed = true;
		});
		return this.#cleanupPromise;
	}

	async #dispose(): Promise<void> {
		if (this.#state.kind === "pending") {
			await this.cancelInitialization(new Error("child runtime launch disposed"));
			return;
		}
		if (this.#state.kind === "admitted") {
			await this.#state.runtime.dispose();
			this.#disposed = true;
			return;
		}
		await this.#beginInitializationCleanup();
	}
}

export function resolveInstalledPiCliPath(): string {
	const packageDir = getPackageDir();
	const packageJsonPath = join(packageDir, "package.json");
	let packageMetadata: unknown;
	try {
		packageMetadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	} catch (error) {
		throw new Error(
			`invalid_pi_package_metadata: could not read package metadata at ${packageJsonPath}`,
			{ cause: error },
		);
	}

	const bin = isRecord(packageMetadata) ? packageMetadata.bin : undefined;
	const piExecutable = isRecord(bin) ? bin.pi : undefined;
	if (typeof piExecutable !== "string" || piExecutable.length === 0) {
		throw new Error(
			`invalid_pi_package_metadata: package.json bin.pi must be a non-empty string at ${packageJsonPath}`,
		);
	}
	return join(packageDir, piExecutable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function assertRuntimeSnapshot(
	actual: PiChildRuntimeSnapshot,
	expected: AgentRunLaunchConfiguration,
	skillPaths: readonly string[],
	projectTrusted: boolean,
	expectedSessionId: string,
	sessionPath: string,
	systemPromptArtifactPath: string | undefined,
): Promise<void> {
	// This is a startup contract, not a restriction on later native activation.
	if ((systemPromptArtifactPath === undefined) !== (expected.systemPrompt === undefined)) {
		throw new Error("child_runtime_system_prompt_mismatch: artifact and configuration disagree");
	}
	const expectedSnapshot: PiChildRuntimeSnapshot = {
		cwd: expected.cwd,
		model: expected.model,
		// An unset selection deliberately delegates this one value to Pi.
		thinking: expected.thinking ?? actual.thinking,
		tools: [...actual.tools],
		skills: [...expected.skills],
		skillSources: await Promise.all(expected.skills.map(async (name, index) => ({
			name,
			filePath: await realpath(skillPaths[index]!),
		}))),
		extensions: await Promise.all(expected.extensions.map((path) => realpath(path))),
		projectTrusted,
		sessionId: expectedSessionId,
		sessionPath,
		systemPrompt: systemPromptArtifactPath === undefined
			? null
			: {
				mode: expected.systemPrompt!.mode,
				filePath: await realpath(systemPromptArtifactPath),
				body: await readFile(systemPromptArtifactPath, "utf8"),
			},
		loadContextFiles: expected.loadContextFiles,
	};
	if (JSON.stringify(actual) !== JSON.stringify(expectedSnapshot)) {
		throw new Error(
			`child_runtime_configuration_mismatch: expected ${JSON.stringify(expectedSnapshot)}, received ${JSON.stringify(actual)}`,
		);
	}
}

async function raceStartup<T>(
	operation: Promise<T>,
	projection: PtyTerminalProjection,
	timeoutMilliseconds: number,
	stage: string,
	cancellation?: Promise<never>,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			...(cancellation === undefined ? [] : [cancellation]),
			projection.exited.then((exit) => {
				throw new Error(
					`child_runtime_early_exit: ${stage} ended with code ${exit.exitCode} signal ${exit.signal}`,
				);
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`child_runtime_startup_timeout: waiting for ${stage}`)),
					timeoutMilliseconds,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function withTerminalDiagnostic(
	error: unknown,
	projection: PtyTerminalProjection,
): Promise<Error> {
	let terminalDiagnostic = "";
	if (!projection.disposed) {
		await projection.drain().catch(() => undefined);
		try {
			terminalDiagnostic = projection.frame().lines
				.map((line) => line.text)
				.filter((line) => line.length > 0)
				.join("\n");
		} catch {
			// Concurrent cancellation can finish PTY cleanup before diagnostics render.
		}
	}
	const cause = error instanceof Error ? error : new Error(String(error));
	return terminalDiagnostic.length === 0
		? cause
		: new Error(`${cause.message}\nChild terminal:\n${terminalDiagnostic}`, { cause });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** One presentation across startup and admission, preserving in-flight hide/show fencing. */
class ChildProcessPresentation {
	#revision = 0;
	#closed = false;
	#releaseScreenView: (() => void) | undefined;
	#boundedHandoff = false;
	readonly projection: PtyTerminalProjection;
	readonly channel: PiChildRuntimeChannel;

	constructor(
		projection: PtyTerminalProjection,
		channel: PiChildRuntimeChannel,
	) {
		this.projection = projection;
		this.channel = channel;
		channel.onClose(() => { this.#closed = true; });
		void projection.exited.then(() => { this.#closed = true; });
	}

	async beginPhysicalTerminalAttachment(handler: (data: string) => void): Promise<() => void> {
		const removeOutputHandler = this.projection.addOutputHandler(handler);
		try {
			await this.beginScreenView();
			return removeOutputHandler;
		} catch (error) {
			removeOutputHandler();
			throw error;
		}
	}

	/**
	 * Resume the child's native screen for a viewer and observe it. Resolves once
	 * the child's complete current frame has been parsed, or once the frame bound
	 * expires: the bracket orders the first published frame, but a child that never
	 * repaints (unsupported, paused, or exiting) must still hand its stream over.
	 * The hidden state resumes on hide.
	 */
	async beginScreenView(): Promise<void> {
		if (this.#closed || this.#releaseScreenView) return;
		const revision = ++this.#revision;
		const releaseScreen = this.projection.addScreenConsumer();
		const frameWait = this.projection.waitForCompleteFrame(SCREEN_VIEW_FRAME_BOUND_MILLISECONDS);
		try {
			await this.setPresentationVisible(true);
			// A bounded handoff still completes: the child's PTY output streams to the
			// viewer either way, so the ordering barrier must never gate visibility.
			if (await frameWait.outcome !== "complete") this.#boundedHandoff = true;
		} catch (error) {
			releaseScreen();
			frameWait.cancel();
			throw error;
		}
		if (revision !== this.#revision || this.#closed) {
			// A concurrent hide already owns the child's visibility.
			releaseScreen();
			return;
		}
		this.#releaseScreenView = releaseScreen;
	}

	/**
	 * What a viewer should know about the last handoff. A bounded handoff is not a
	 * failure, but it explains a child view that starts mid-frame or never paints.
	 */
	screenViewDiagnostic(): string | undefined {
		return this.#boundedHandoff ? SCREEN_VIEW_FRAME_TIMEOUT_DIAGNOSTIC : undefined;
	}

	hidePresentation(): Promise<void> {
		++this.#revision;
		this.#releaseScreenView?.();
		this.#releaseScreenView = undefined;
		if (this.#closed) return Promise.resolve();
		this.projection.resumeOutput();
		return this.setPresentationVisible(false).catch(error => {
			// Exact process cleanup owns a disconnected channel, not the UI hide.
			if (!this.#closed) throw error;
		});
	}

	setPresentationVisible(visible: boolean): Promise<void> {
		return this.channel.request("presentation.setVisible", { visible }).then(() => undefined);
	}
}

function forceKillProjection(projection: PtyTerminalProjection): void {
	try {
		projection.killProcessGroup("SIGKILL");
	} catch {
		// A concurrent group exit is success; exact leader settlement is observed via exited.
	}
}

async function completeCleanup(
	actions: readonly (() => Promise<unknown>)[],
): Promise<void> {
	const errors: Error[] = [];
	for (const action of actions) {
		try {
			await action();
		} catch (error) {
			errors.push(asError(error));
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "child_runtime_cleanup_failed");
}

async function createRuntimeArtifactDirectory(runtimeDirectory?: string): Promise<string> {
	const root = runtimeDirectory
		?? process.env.XDG_RUNTIME_DIR
		?? tmpdir();
	if (!isAbsolute(root)) {
		throw new Error("invalid_child_runtime: runtime directory must be absolute");
	}
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, "pi-ac-runtime-"));
	// POSIX modes do not model Windows ACLs; on Windows the unique directory
	// inherits the current user's temporary-directory access policy.
	try {
		if (process.platform !== "win32") await chmod(directory, 0o700);
		return directory;
	} catch (error) {
		await removeEmptyDirectory(directory).catch(() => undefined);
		throw error;
	}
}

async function removeEmptyDirectory(path: string): Promise<void> {
	try {
		await rmdir(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function requireIdentity(field: string, value: string): string {
	if (value.length === 0) throw new Error(`invalid_child_runtime: ${field} is required`);
	return value;
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
