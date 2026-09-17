import { AgentSession } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pi-durable-subagents.test.captured-agent-sessions");
type Registry = {
	sessions: Map<string, AgentSession>;
	installed: boolean;
};

const registry = (() => {
	const globalRegistry = globalThis as typeof globalThis & {
		[REGISTRY_KEY]?: Registry;
	};
	globalRegistry[REGISTRY_KEY] ??= { sessions: new Map(), installed: false };
	return globalRegistry[REGISTRY_KEY];
})();

if (!registry.installed) {
	registry.installed = true;
	const nativeSubscribe = AgentSession.prototype.subscribe;
	AgentSession.prototype.subscribe = function captureSession(listener) {
		registry.sessions.set(this.sessionId, this);
		return nativeSubscribe.call(this, listener);
	};
}

export function capturedAgentSession(agentId: string): AgentSession {
	const session = registry.sessions.get(agentId);
	if (!session) throw new Error(`Agent session ${agentId} was not captured`);
	return session;
}
