import { createPhysicalTestDisplay } from "./physical-test-display.ts";
import {
	createFauxCore,
	fauxAssistantMessage,
	getCurrentTools,
	type FauxResponseStep,
	type TranscriptContext,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getPackageDir,
	type CreateAgentSessionRuntimeFactory,
	type AgentSession,
	type AgentSessionServices,
	type ExtensionFactory,
	type InlineExtension,
	type ExtensionUIContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";

import {
	createProcessModelBroker,
	type ProcessModelBroker,
} from "./process-model-broker.ts";

const PROVIDER_ID = "coordination-test";
const MODEL_ID = "deterministic-owner";
const PROVIDER_BASE_URL = "http://coordination-test.invalid";

// Production discovers user Agent Templates under HOME. Give every test-file
// process an isolated home so developer-installed templates cannot replace its
// deterministic models or tools.
process.env.HOME = await mkdtemp(join(tmpdir(), "pi-durable-subagents-test-home-"));
// PTY fixtures are Owner processes. A Pi-hosted test runner may itself carry the
// child-only bootstrap variable; child launches replace it with their own path.
delete process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP;
delete process.env.PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_MODE;
delete process.env.PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_PATH;
delete process.env.PI_DURABLE_SUBAGENTS_LOAD_CONTEXT_FILES;

async function loadPiBuiltInExtensionFactories(): Promise<readonly InlineExtension[]> {
	const modulePath = join(getPackageDir(), "dist", "extensions", "index.js");
	const moduleValue = await import(pathToFileURL(modulePath).href) as {
		builtInExtensions?: unknown;
	};
	if (!Array.isArray(moduleValue.builtInExtensions)) {
		throw new Error("Incompatible Pi test host: built-in extension registry is unavailable");
	}
	return moduleValue.builtInExtensions as InlineExtension[];
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
} as const;

export type TestUi = ExtensionUIContext & {
	readonly genericSelectCalls: Array<{ title: string; options: string[] }>;
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
	readonly customSurfaces: Component[];
	readonly statuses: Map<string, string>;
	readonly widgets: Map<string, readonly string[] | Component>;
};

export type TestOwnerHost = {
	cwd: string;
	services: AgentSessionServices;
	session: AgentSession;
	runtime: AgentSessionRuntime;
	ui: TestUi;
	model: {
		setResponses(responses: FauxResponseStep[]): void;
	};
	deferCleanup(cleanup: () => void | Promise<void>): void;
	dispose(): Promise<void>;
};

export type TestCleanupRegistrar = Pick<TestContext, "after">;

export type TestOwnerHostOptions = {
	physicalDisplay?: boolean;
	persistent?: boolean;
	additionalExtensionPaths?: string[];
	additionalExtensionFactories?: InlineExtension[];
	cwd?: string;
	agentDir?: string;
	sessionFile?: string;
	implicitModeratorResponses?: boolean;
	fauxTokensPerSecond?: number;
	processVisibleModel?: boolean;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	noPromptTemplates?: boolean;
};

export async function createTestOwnerHost(
	t: TestCleanupRegistrar,
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = registerTestOwnerHostCleanup(
		t,
		await createManuallyManagedUnboundTestOwnerHost(extension, options),
	);
	await bindTestOwnerHost(host, "tui");
	return host;
}

export async function createPiCliTestOwnerHost(
	t: TestCleanupRegistrar,
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = registerTestOwnerHostCleanup(
		t,
		await createUnboundTestOwnerHostWithRuntime(
			extension,
			options,
			await loadPiBuiltInExtensionFactories(),
			// Avoid an unrelated public-catalog refresh during local-provider conformance.
			// The runtime remains network-enabled, so the named provider can explicitly
			// refresh and infer against the test's loopback router.
			false,
		),
	);
	await bindTestOwnerHost(host, "tui");
	return host;
}

export async function createUnboundTestOwnerHost(
	t: TestCleanupRegistrar,
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	return registerTestOwnerHostCleanup(
		t,
		await createManuallyManagedUnboundTestOwnerHost(extension, options),
	);
}

/** Standalone fixture programs own their Runtime lifecycle outside node:test. */
export async function createManuallyManagedUnboundTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	return createUnboundTestOwnerHostWithRuntime(extension, options, [], false);
}

function registerTestOwnerHostCleanup(
	t: TestCleanupRegistrar,
	host: TestOwnerHost,
): TestOwnerHost {
	t.after(() => host.dispose());
	return host;
}

async function createUnboundTestOwnerHostWithRuntime(
	extension: ExtensionFactory,
	options: TestOwnerHostOptions | undefined,
	piBuiltInExtensionFactories: readonly InlineExtension[],
	allowModelNetwork: boolean,
): Promise<TestOwnerHost> {
	const cwd = options?.cwd ?? await mkdtemp(join(tmpdir(), "pi-durable-subagents-"));
	const agentDir = options?.agentDir ?? join(cwd, ".pi-agent");
	const additionalExtensionFactories = options?.additionalExtensionFactories ?? [];
	const sessionManager = options?.sessionFile
		? SessionManager.open(options.sessionFile)
		: options?.persistent
			? SessionManager.create(cwd, join(cwd, "sessions"))
			: SessionManager.inMemory(cwd);
	const { modelRuntime, faux, processModelBroker } = await createTestModelRuntime({
		implicitModeratorResponses: options?.implicitModeratorResponses ?? true,
		allowModelNetwork,
		fauxTokensPerSecond: options?.fauxTokensPerSecond,
		processVisibleModel: options?.processVisibleModel ?? false,
	});
	const additionalExtensionPaths = [
		...(options?.additionalExtensionPaths ?? []),
		...(processModelBroker ? [processModelBroker.extensionPath] : []),
	];
	const retainedExtensionPaths = new Set(additionalExtensionPaths);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(options?.settings),
			resourceLoaderOptions: {
				noContextFiles: true,
				noPromptTemplates: options?.noPromptTemplates ?? true,
				noSkills: true,
				noThemes: true,
				additionalExtensionPaths,
				extensionFactories: [
					...piBuiltInExtensionFactories,
					...additionalExtensionFactories,
					{
						name: "pi-durable-subagents",
						hidden: false,
						factory: extension,
					},
				],
				extensionsOverride: (loaded) => ({
					...loaded,
					extensions: loaded.extensions.filter(
						(candidate) =>
							candidate.path.startsWith("<inline:") ||
							retainedExtensionPaths.has(candidate.resolvedPath),
					),
				}),
			},
		});
		const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
		if (!model) throw new Error("Deterministic test model was not registered");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model,
			thinkingLevel: "off",
			noTools: "builtin",
		});
		return {
			...created,
			services,
			diagnostics: [...services.diagnostics],
		};
	};
	let initial: Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>;
	try {
		initial = await createRuntime({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
	} catch (error) {
		await processModelBroker?.close();
		throw error;
	}
	const runtime = new AgentSessionRuntime(
		initial.session,
		initial.services,
		createRuntime,
		initial.diagnostics,
		initial.modelFallbackMessage,
	);
	if (processModelBroker) closeProcessModelBrokerWithRuntime(runtime, processModelBroker);
	const ui = createTestUi();
	const deferredCleanups: Array<() => void | Promise<void>> = [];
	let disposal: Promise<void> | undefined;
	const host: TestOwnerHost = {
		cwd,
		services: initial.services,
		session: initial.session,
		runtime,
		ui,
		model: faux,
		deferCleanup(cleanup) {
			if (disposal) throw new Error("Test Owner host disposal already started");
			deferredCleanups.push(cleanup);
		},
		dispose() {
			disposal ??= disposeTestOwnerHost(runtime, deferredCleanups);
			return disposal;
		},
	};
	if (options?.physicalDisplay) {
		const display = createPhysicalTestDisplay((active) => {
			const index = ui.customSurfaces.indexOf(display.view);
			if (active && index < 0) ui.customSurfaces.push(display.view);
			if (!active && index >= 0) ui.customSurfaces.splice(index, 1);
		});
		host.deferCleanup(async () => {
			// Restore stdio only after the production attachment has released its lease.
			try {
				await runtime.dispose();
			} finally {
				display.dispose();
			}
		});
	}
	return host;
}

async function disposeTestOwnerHost(
	runtime: AgentSessionRuntime,
	deferredCleanups: Array<() => void | Promise<void>>,
): Promise<void> {
	const errors: unknown[] = [];
	for (const cleanup of deferredCleanups.reverse()) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	try {
		await runtime.dispose();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Test Owner host cleanup failed");
	}
}

function closeProcessModelBrokerWithRuntime(
	runtime: AgentSessionRuntime,
	broker: ProcessModelBroker,
): void {
	const disposeRuntime = runtime.dispose.bind(runtime);
	let disposal: Promise<void> | undefined;
	runtime.dispose = () => disposal ??= (async () => {
		try {
			await disposeRuntime();
		} finally {
			await broker.close();
		}
	})();
}

export async function bindTestOwnerHost(
	host: TestOwnerHost,
	mode: "tui" | "rpc" | "json" | "print",
): Promise<void> {
	const bindSession = (session: AgentSession) => session.bindExtensions({
		uiContext: host.ui,
		mode,
		onError: (error) => host.ui.notify(error.error, "error"),
	});
	if (mode === "tui") {
		// InteractiveMode installs these callbacks before it binds extensions. Using
		// the real runtime here preserves that observable startup order without a TTY.
		host.runtime.setBeforeSessionInvalidate(() => undefined);
		host.runtime.setRebindSession(bindSession);
	}
	await bindSession(host.session);
}

function createTestUi(): TestUi {
	const genericSelectCalls: TestUi["genericSelectCalls"] = [];
	const notifications: TestUi["notifications"] = [];
	const customSurfaces: Component[] = [];
	const statuses: TestUi["statuses"] = new Map();
	const widgets: TestUi["widgets"] = new Map();
	let editorComponent: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	let editorText = "";
	const inputListeners = new Set<unknown>();
	const testTui = {
		mode: "regular",
		terminal: { columns: 80, rows: 24, write() {} },
		inputListeners,
		addInputListener(listener: unknown) {
			inputListeners.add(listener);
			return () => { inputListeners.delete(listener); };
		},
		renderNow() {},
		requestRender() {},
		start() {},
		stop() {},
	} as unknown as TUI;
	const testTheme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const custom: ExtensionUIContext["custom"] = <T>(factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>, options?: {
		overlay?: boolean;
		overlayOptions?: Parameters<TUI["showOverlay"]>[1] | (() => Parameters<TUI["showOverlay"]>[1]);
		onHandle?: (handle: OverlayHandle) => void;
	}) => {
		return new Promise<T>((resolve, reject) => {
			let component: (Component & { dispose?(): void }) | undefined;
			let finished = false;
			const done = (result: T) => {
				if (finished) return;
				finished = true;
				if (component) {
					const index = customSurfaces.indexOf(component);
					if (index >= 0) customSurfaces.splice(index, 1);
					component.dispose?.();
				}
				resolve(result);
			};
			Promise.resolve(
				factory(
					testTui,
					testTheme,
					{} as KeybindingsManager,
					done,
				),
			).then((created) => {
				component = created;
				customSurfaces.push(created);
				options?.onHandle?.(createTestOverlayHandle(() => {
					const index = customSurfaces.indexOf(created);
					if (index >= 0) customSurfaces.splice(index, 1);
				}));
			}, reject);
		});
	};
	return {
		genericSelectCalls,
		notifications,
		customSurfaces,
		statuses,
		widgets,
		async select(title: string, options: string[]) {
			genericSelectCalls.push({ title, options: [...options] });
			return undefined;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		onTerminalInput() {
			return () => undefined;
		},
		setStatus(key: string, value: string | undefined) {
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget(
			key: string,
			value:
				| readonly string[]
				| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
				| undefined,
		) {
			if (value === undefined) widgets.delete(key);
			else widgets.set(
				key,
				typeof value === "function" ? value(testTui, testTheme) : value,
			);
		},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom,
		pasteToEditor() {},
		setEditorText(text: string) {
			editorText = text;
		},
		getEditorText() {
			return editorText;
		},
		async editor() {
			return undefined;
		},
		setEditorComponent(factory: ReturnType<ExtensionUIContext["getEditorComponent"]>) {
			editorComponent = factory;
		},
		getEditorComponent() {
			return editorComponent;
		},
		theme: testTheme,
	} as unknown as TestUi;
}

function createTestOverlayHandle(onHide?: () => void): OverlayHandle {
	let hidden = false;
	let focused = true;
	return {
		hide() {
			if (hidden) return;
			hidden = true;
			focused = false;
			onHide?.();
		},
		setHidden(value) {
			hidden = value;
		},
		isHidden() {
			return hidden;
		},
		focus() {
			focused = true;
			hidden = false;
		},
		unfocus() {
			focused = false;
		},
		isFocused() {
			return focused;
		},
		getBounds() {
			return undefined;
		},
	};
}

async function createTestModelRuntime(options: {
	implicitModeratorResponses: boolean;
	allowModelNetwork: boolean;
	fauxTokensPerSecond?: number;
	processVisibleModel: boolean;
}): Promise<{
	modelRuntime: ModelRuntime;
	faux: { setResponses(responses: FauxResponseStep[]): void };
	processModelBroker?: ProcessModelBroker;
}> {
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: options.allowModelNetwork,
		modelsPath: null,
	});
	if (options.processVisibleModel) {
		const processModelBroker = await createProcessModelBroker({
			providerId: PROVIDER_ID,
			modelId: MODEL_ID,
			modelName: "Deterministic Owner",
			tokensPerSecond: options.fauxTokensPerSecond,
			responseOverride: (context) => {
				const response = options.implicitModeratorResponses
					? implicitOperationalResponse(context)
					: undefined;
				return response ? fauxAssistantMessage(response) : undefined;
			},
			responses: [fauxAssistantMessage("Owner interaction preserved.")],
		});
		return {
			modelRuntime,
			faux: processModelBroker,
			processModelBroker,
		};
	}
	const faux = createFauxCore({
		api: PROVIDER_ID,
		provider: PROVIDER_ID,
		tokensPerSecond: options.fauxTokensPerSecond,
		models: [
			{
				id: MODEL_ID,
				name: "Deterministic Owner",
				reasoning: false,
				input: ["text"],
				cost: EMPTY_USAGE.cost,
				contextWindow: 16_384,
				maxTokens: 256,
			},
		],
	});
	faux.setResponses([fauxAssistantMessage("Owner interaction preserved.")]);
	const maybeImplicitOperationalResponse = (
		model: Model<string>,
		context: TranscriptContext,
		streamOptions: StreamOptions | SimpleStreamOptions | undefined,
	) => {
		const response = options.implicitModeratorResponses
			? implicitOperationalResponse(context)
			: undefined;
		if (!response) return undefined;
		const implicit = createFauxCore({
			api: PROVIDER_ID,
			provider: PROVIDER_ID,
			models: [
				{
					id: MODEL_ID,
					name: "Deterministic Owner",
					reasoning: false,
					input: ["text"],
					cost: EMPTY_USAGE.cost,
					contextWindow: 16_384,
					maxTokens: 256,
				},
			],
		});
		implicit.setResponses([fauxAssistantMessage(response)]);
		return implicit.streamSimple(model, context, streamOptions);
	};
	modelRuntime.registerProvider(PROVIDER_ID, {
		name: "Coordination test",
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_ID,
		apiKey: "in-memory-test",
		models: faux.models,
		streamSimple: (model, context, streamOptions) =>
			maybeImplicitOperationalResponse(model, context, streamOptions) ??
			faux.streamSimple(model, context, streamOptions),
	});
	return { modelRuntime, faux };
}

function implicitOperationalResponse(context: TranscriptContext): string | undefined {
	if (isImplicitObligationReminder(context)) {
		return "I remain settled after the automatic Answer reminder.";
	}
	return isImplicitModeratorRequest(context)
		? "I will wait for explicit Moderator work."
		: undefined;
}

function isImplicitObligationReminder(context: TranscriptContext): boolean {
	const latestMessage = JSON.stringify(context.messages.at(-1));
	return typeof latestMessage === "string" &&
		latestMessage.includes("requestTitle") &&
		latestMessage.includes("This Request still needs an Answer.");
}

function isImplicitModeratorRequest(context: TranscriptContext): boolean {
	return (
		getCurrentTools(context.messages).some(({ name }) => name === "moderator_control") &&
		context.messages.some((message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) =>
					part.type === "text" &&
					part.text.includes('"kind":"obligation_stall"'),
			)
		)
	);
}
