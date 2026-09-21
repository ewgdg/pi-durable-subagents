import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	assertHostModuleShape,
	assertRuntimeInstanceShape,
	IncompatiblePiHostError,
} from "./host-shape.ts";
import {
	captureInteractivePresentation,
	type InteractivePresentation,
} from "./interactive-presentation.ts";

type RuntimeRebind = (session: AgentSession) => Promise<void>;
type RuntimePrototype = {
	setRebindSession(rebindSession?: RuntimeRebind): void;
};
type SessionPrototype = {
	bindExtensions: AgentSession["bindExtensions"];
};
type HostModule = {
	VERSION?: unknown;
	AgentSessionRuntime: {
		prototype: RuntimePrototype;
	};
	AgentSession: {
		prototype: SessionPrototype;
	};
};

type RuntimeWaiter = {
	sessionManager: SessionManager;
	resolve(runtime: AgentSessionRuntime): void;
	reject(error: unknown): void;
};

type BridgeState = {
	runtimesBySessionManager: WeakMap<SessionManager, AgentSessionRuntime>;
	presentationsByRuntime: WeakMap<AgentSessionRuntime, InteractivePresentation>;
	nativeRebindByRuntime: WeakMap<AgentSessionRuntime, RuntimeRebind | undefined>;
	waiters: RuntimeWaiter[];
	validate(runtime: AgentSessionRuntime): AgentSessionRuntime;
};

export type InteractiveHostBridge = {
	capture(
		sessionManager: SessionManager,
		ui: ExtensionUIContext,
	): Promise<Readonly<{
		runtime: AgentSessionRuntime;
		setPresentationVisible(visible: boolean): void;
		setNativeEditorRequired(required: boolean): void;
	}>>;
};

const BRIDGE_REGISTRY_KEY = "__piAgentCoordinationInteractiveHostBridge";
const globalBridgeRegistry = globalThis as typeof globalThis & {
	[BRIDGE_REGISTRY_KEY]?: WeakMap<object, BridgeState>;
};
// Pi may re-evaluate extension modules during resource reload. Process-global
// ownership prevents a second evaluation from stacking host patches.
const bridgeStates = (globalBridgeRegistry[BRIDGE_REGISTRY_KEY] ??= new WeakMap());

export function installInteractiveHostBridge(hostValue: unknown): InteractiveHostBridge {
	assertHostModuleShape(hostValue);
	const host = hostValue as HostModule & object;
	const bridgeKey = host.AgentSessionRuntime.prototype;
	let state = bridgeStates.get(bridgeKey);
	if (!state) {
		state = installRuntimeCapture(host);
		bridgeStates.set(bridgeKey, state);
	}

	return {
		capture(sessionManager, ui) {
			const runtime = state.runtimesBySessionManager.get(sessionManager);
			if (runtime) {
				try {
					return Promise.resolve(bindInteractivePresentation(
						state,
						state.validate(runtime),
						ui,
					));
				} catch (error) {
					return Promise.reject(error);
				}
			}
			return new Promise<AgentSessionRuntime>((resolve, reject) =>
				state.waiters.push({ sessionManager, resolve, reject })
			).then((capturedRuntime) =>
				bindInteractivePresentation(state, capturedRuntime, ui)
			);
		},
	};
}

function installRuntimeCapture(host: HostModule): BridgeState {
	const state: BridgeState = {
		runtimesBySessionManager: new WeakMap(),
		presentationsByRuntime: new WeakMap(),
		nativeRebindByRuntime: new WeakMap(),
		waiters: [],
		validate: () => {
			throw new Error("Interactive Runtime validation is not installed");
		},
	};
	const runtimePrototype = host.AgentSessionRuntime.prototype;
	const originalSetRebindSession = runtimePrototype.setRebindSession;
	const sessionPrototype = host.AgentSession.prototype;
	const originalBindExtensions = sessionPrototype.bindExtensions;
	const rejectInteractiveAdmission = (
		error: unknown,
		runtime?: AgentSessionRuntime,
	) => {
		if (runtime && state.nativeRebindByRuntime.has(runtime)) {
			originalSetRebindSession.call(
				runtime,
				state.nativeRebindByRuntime.get(runtime),
			);
			state.nativeRebindByRuntime.delete(runtime);
		}
		if (runtimePrototype.setRebindSession === captureInteractiveRuntime) {
			runtimePrototype.setRebindSession = originalSetRebindSession;
		}
		if (sessionPrototype.bindExtensions === validateInteractiveBinding) {
			sessionPrototype.bindExtensions = originalBindExtensions;
		}
		bridgeStates.delete(host.AgentSessionRuntime.prototype);
		for (const waiter of state.waiters.splice(0)) waiter.reject(error);
	};

	const captureInteractiveRuntime = function captureInteractiveRuntime(
		this: unknown,
		rebindSession?: RuntimeRebind,
	): void {
		const runtime = this as AgentSessionRuntime;
		state.nativeRebindByRuntime.set(runtime, rebindSession);
		publishCapture(state, runtime, runtime.session.sessionManager);
		const observedRebind = rebindSession && (async (session: AgentSession) => {
			// The public Runtime callback is the exact handoff to a replacement
			// session. Publish it before extension session_start waits for capture.
			publishCapture(state, runtime, session.sessionManager);
			await rebindSession(session);
			state.presentationsByRuntime.get(runtime)?.requestFullRender();
		});
		originalSetRebindSession.call(runtime, observedRebind);
	};
	const validateInteractiveBinding: AgentSession["bindExtensions"] = async function (
		this: AgentSession,
		bindings,
	): Promise<void> {
		if (bindings.mode === "tui") {
			const runtime = state.runtimesBySessionManager.get(this.sessionManager);
			if (!runtime) {
				const error = new IncompatiblePiHostError(
					"AgentSessionRuntime interactive capture",
					host.VERSION,
				);
				rejectInteractiveAdmission(error);
				throw error;
			}
			state.validate(runtime);
		}
		await originalBindExtensions.call(this, bindings);
	};
	state.validate = (runtime) => {
		try {
			assertRuntimeInstanceShape(runtime, host.VERSION);
			return runtime;
		} catch (error) {
			// Structural validation belongs to interactive admission. Headless modes
			// may call the observed public setter but never inspect their Runtime.
			rejectInteractiveAdmission(error, runtime);
			throw error;
		}
	};
	runtimePrototype.setRebindSession = captureInteractiveRuntime;
	sessionPrototype.bindExtensions = validateInteractiveBinding;

	return state;
}

function bindInteractivePresentation(
	state: BridgeState,
	runtime: AgentSessionRuntime,
	ui: ExtensionUIContext,
) {
	const presentation = captureInteractivePresentation(ui);
	state.presentationsByRuntime.set(runtime, presentation);
	return {
		runtime,
		setPresentationVisible: presentation.setVisible,
		setNativeEditorRequired: presentation.setNativeEditorRequired,
	};
}

function publishCapture(
	state: BridgeState,
	runtime: AgentSessionRuntime,
	sessionManager: SessionManager,
): void {
	state.runtimesBySessionManager.set(sessionManager, runtime);
	const matchingWaiters = state.waiters.filter(
		(waiter) => waiter.sessionManager === sessionManager,
	);
	if (matchingWaiters.length === 0) return;
	for (const waiter of matchingWaiters) {
		state.waiters.splice(state.waiters.indexOf(waiter), 1);
	}
	let capture: AgentSessionRuntime;
	try {
		capture = state.validate(runtime);
	} catch (error) {
		for (const waiter of matchingWaiters) waiter.reject(error);
		return;
	}
	for (const waiter of matchingWaiters) {
		waiter.resolve(capture);
	}
}
