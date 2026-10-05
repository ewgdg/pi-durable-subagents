import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";

import type { PhysicalTerminalPort } from "../../src/presentation/physical-terminal-attachment.ts";
import type { TerminalProjection } from "../../src/presentation/terminal-projection.ts";
import type { DurableAgentView } from "../../src/presentation/agent-view-surface.ts";

const AGENT_ID = "agent-view-durable-12345678";

/** Fakes for driving a physical Agent view: a child projection, its durable view, and the Owner terminal. */
export function createProjectionHarness(
	name: string,
	reinitializationFailure?: Error,
	blockReinitialization = false,
	blockDetachment = false,
	existingFailure?: Error,
): {
	projection: TerminalProjection;
	waitForReinitialization(): Promise<void>;
	finishReinitialization(): Promise<void>;
	waitForDetachment(): Promise<void>;
	finishDetachment(): Promise<void>;
	emitOutput(data: string): void;
	emitFailure(error: unknown): void;
	emitExitRequest(): void;
	attachedStates(): readonly boolean[];
	outputPauses(): number;
	outputResumes(): number;
	inputs(): readonly string[];
	resizes(): readonly Readonly<{ columns: number; rows: number }>[];
} {
	const outputHandlers = new Set<(data: string) => void>();
	const failureHandlers = new Set<(error: unknown) => void>();
	const exitHandlers = new Set<() => void>();
	const attachedStates: boolean[] = [];
	let outputPauses = 0;
	let outputResumes = 0;
	const inputs: string[] = [];
	const resizes: Array<{ columns: number; rows: number }> = [];
	let settleReinitialization!: () => void;
	const reinitialized = new Promise<void>((resolve) => {
		settleReinitialization = resolve;
	});
	let releaseReinitialization!: () => void;
	const reinitializationGate = new Promise<void>((resolve) => {
		releaseReinitialization = resolve;
	});
	let settleReinitializationFinished!: () => void;
	const reinitializationFinished = new Promise<void>((resolve) => {
		settleReinitializationFinished = resolve;
	});
	let settleDetachmentStarted!: () => void;
	const detachmentStarted = new Promise<void>((resolve) => {
		settleDetachmentStarted = resolve;
	});
	let releaseDetachment!: () => void;
	const detachmentGate = new Promise<void>((resolve) => {
		releaseDetachment = resolve;
	});
	let settleDetachmentFinished!: () => void;
	const detachmentFinished = new Promise<void>((resolve) => {
		settleDetachmentFinished = resolve;
	});
	const projection: TerminalProjection = {
		presentation: {
			render: () => [name],
			invalidate() {},
		},
		screenView: {
			async begin() {},
			async end() {},
		},
		physicalTerminal: {
			async beginAttachment(handler) {
				attachedStates.push(true);
				outputHandlers.add(handler);
				settleReinitialization();
				if (blockReinitialization) await reinitializationGate;
				settleReinitializationFinished();
				if (reinitializationFailure) throw reinitializationFailure;
				return () => outputHandlers.delete(handler);
			},
			async endAttachment() {
				attachedStates.push(false);
				settleDetachmentStarted();
				if (blockDetachment) await detachmentGate;
				settleDetachmentFinished();
			},
			pauseOutput() {
				outputPauses += 1;
			},
			resumeOutput() {
				outputResumes += 1;
			},
		},
		resize(columns, rows) {
			resizes.push({ columns, rows });
		},
		dispatchInput(data) {
			inputs.push(data);
		},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler(handler) {
			failureHandlers.add(handler);
			if (existingFailure) handler(existingFailure);
			return () => failureHandlers.delete(handler);
		},
		addExitRequestHandler(handler) {
			exitHandlers.add(handler);
			return () => exitHandlers.delete(handler);
		},
	};
	return {
		projection,
		waitForReinitialization: () => reinitialized,
		async finishReinitialization() {
			releaseReinitialization();
			await reinitializationFinished;
			await Promise.resolve();
		},
		waitForDetachment: () => detachmentStarted,
		async finishDetachment() {
			releaseDetachment();
			await detachmentFinished;
			await Promise.resolve();
		},
		emitOutput(data) {
			for (const handler of outputHandlers) handler(data);
		},
		emitFailure(error) {
			for (const handler of failureHandlers) handler(error);
		},
		emitExitRequest() {
			for (const handler of exitHandlers) handler();
		},
		// Repeated hide is idempotent; assert state transitions, not cleanup call counts.
		attachedStates: () => attachedStates.filter((state, index) =>
			index === 0 || state !== attachedStates[index - 1]),
		outputPauses: () => outputPauses,
		outputResumes: () => outputResumes,
		inputs: () => inputs,
		resizes: () => resizes,
	};
}

export function createViewHarness(initialProjection: TerminalProjection): {
	view: DurableAgentView;
	replaceProjection(projection: TerminalProjection): void;
	closeFromHost(): Promise<void>;
	cleanupCount(): number;
	failures(): readonly unknown[];
} {
	let projection = initialProjection;
	let closed = false;
	let cleanups = 0;
	const failures: unknown[] = [];
	const changeHandlers = new Set<() => void>();
	const closeHandlers = new Set<() => void>();
	const view: DurableAgentView = {
		agentId: AGENT_ID,
		label: "Durable Agent",
		projection: () => projection,
		addPresentationHandler(handler) {
			changeHandlers.add(handler);
			return () => changeHandlers.delete(handler);
		},
		addCloseHandler(handler) {
			closeHandlers.add(handler);
			return () => closeHandlers.delete(handler);
		},
		async close() {
			if (closed) return;
			closed = true;
			cleanups += 1;
			for (const handler of closeHandlers) handler();
		},
		fail(error) {
			failures.push(error);
			void view.close();
		},
	};
	return {
		view,
		replaceProjection(next) {
			projection = next;
			for (const handler of changeHandlers) handler();
		},
		closeFromHost: () => view.close(),
		cleanupCount: () => cleanups,
		failures: () => failures,
	};
}

export function createSurfaceHarness(options: Readonly<{
	supportsPhysicalAttachment?: boolean;
	backpressureOn?: string;
	writeFailure?: Error;
}> = {}): {
	ui: ExtensionUIContext;
	ownerTui: TUI;
	physicalTerminal: PhysicalTerminalPort;
	emitInput(data: string): void;
	emitDiagnosticInput(data: string): void;
	emitResize(columns: number, rows: number): void;
	releaseBackpressure(): Promise<void>;
	physicalWrites(): readonly string[];
	physicalStarts(): number;
	physicalStops(): number;
	ownerStops(): readonly Readonly<{ preserveScreen?: boolean }>[];
	ownerStarts(): number;
	ownerRenderRequests(): readonly boolean[];
} {
	let activeInput: ((data: string) => void) | undefined;
	let activeResize: ((columns: number, rows: number) => void) | undefined;
	const physicalWrites: string[] = [];
	let settleBackpressure!: () => void;
	const backpressure = new Promise<void>((resolve) => {
		settleBackpressure = resolve;
	});
	let physicalStarts = 0;
	let physicalStops = 0;
	const ownerStops: Array<{ preserveScreen?: boolean }> = [];
	let ownerStarts = 0;
	const ownerRenderRequests: boolean[] = [];
	const physicalTerminal: PhysicalTerminalPort = {
		supportsPhysicalAttachment: options.supportsPhysicalAttachment ?? true,
		columns: () => 80,
		rows: () => 24,
		write(data) {
			if (options.writeFailure) throw options.writeFailure;
			physicalWrites.push(data);
			return data !== options.backpressureOn;
		},
		waitForDrain: () => backpressure,
		start(onInput, onResize) {
			physicalStarts += 1;
			activeInput = onInput;
			activeResize = onResize;
		},
		stop() {
			physicalStops += 1;
			activeInput = undefined;
			activeResize = undefined;
		},
	};
	let customComponent: Component | undefined;
	let focused = true;
	const handle: OverlayHandle = {
		hide() {
			focused = false;
			customComponent = undefined;
		},
		setHidden(value) {
			focused = !value;
		},
		isHidden: () => !focused,
		focus() {
			focused = true;
		},
		unfocus() {
			focused = false;
		},
		isFocused: () => focused,
		getBounds: () => undefined,
	};
	const inputListeners = new Set<(
		data: string,
	) => Readonly<{ consume?: boolean; data?: string }> | undefined>();
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 80, rows: 24, write() {} },
		inputListeners,
		addInputListener(listener: (
			data: string,
		) => Readonly<{ consume?: boolean; data?: string }> | undefined) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		stop(options?: { preserveScreen?: boolean }) {
			ownerStops.push(options ?? {});
		},
		start() {
			ownerStarts += 1;
		},
		requestRender(force = false) {
			ownerRenderRequests.push(force);
		},
	} as unknown as TUI;
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options?: { onHandle?: (handle: OverlayHandle) => void },
		) => new Promise<T>(() => {
			customComponent = factory(
				tui,
				{} as Theme,
				{} as KeybindingsManager,
				() => undefined,
			);
			options?.onHandle?.(handle);
		}),
	} as unknown as ExtensionUIContext;
	return {
		ui,
		ownerTui: tui,
		physicalTerminal,
		emitInput(data) {
			if (activeInput) {
				activeInput(data);
				return;
			}
			let current = data;
			for (const listener of inputListeners) {
				const result = listener(current);
				if (result?.consume) return;
				if (result?.data !== undefined) current = result.data;
			}
		},
		emitDiagnosticInput(data) {
			customComponent?.handleInput?.(data);
		},
		emitResize(columns, rows) {
			activeResize?.(columns, rows);
		},
		async releaseBackpressure() {
			settleBackpressure();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		physicalWrites: () => physicalWrites,
		physicalStarts: () => physicalStarts,
		physicalStops: () => physicalStops,
		ownerStops: () => ownerStops,
		ownerStarts: () => ownerStarts,
		ownerRenderRequests: () => ownerRenderRequests,
	};
}
