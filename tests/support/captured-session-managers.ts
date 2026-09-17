import { SessionManager } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pi-durable-subagents.test.captured-session-managers");
type Registry = {
	managers: Map<string, SessionManager>;
	installed: boolean;
};

const registry = (() => {
	const globalRegistry = globalThis as typeof globalThis & {
		[REGISTRY_KEY]?: Registry;
	};
	globalRegistry[REGISTRY_KEY] ??= { managers: new Map(), installed: false };
	return globalRegistry[REGISTRY_KEY];
})();

if (!registry.installed) {
	registry.installed = true;
	const nativeCreate = SessionManager.create.bind(SessionManager);
	SessionManager.create = (...args: Parameters<typeof SessionManager.create>) => {
		const manager = nativeCreate(...args);
		registry.managers.set(manager.getSessionId(), manager);
		return manager;
	};
}

export function capturedSessionManager(sessionId: string): SessionManager {
	const manager = registry.managers.get(sessionId);
	if (!manager) throw new Error(`SessionManager ${sessionId} was not captured`);
	return manager;
}
