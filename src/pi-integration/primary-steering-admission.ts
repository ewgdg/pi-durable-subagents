import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { isHumanInputSource } from "./participant-lifecycle.ts";

/**
 * Observe one human steering input only after Pi has added its message to the
 * native queue. Agent Wait must not resume from the earlier input hook: that
 * can let its tool result start a model call before AgentSession queues the text.
 * TUI steers through prompt(); an RPC client's steer command calls steer().
 */
export function bindPrimarySteeringAdmission(
	session: AgentSession,
	onQueued: () => void | Promise<void>,
	onError: (error: unknown) => void,
): () => void {
	const notifyWhenQueued = (pendingMessageCountBeforeInput: number) => {
		if (session.pendingMessageCount <= pendingMessageCountBeforeInput) return;
		void Promise.resolve(onQueued()).catch(onError);
	};
	const originalPrompt = session.prompt.bind(session);
	const observedPrompt: AgentSession["prompt"] = async (text, options) => {
		const observesPrimarySteering =
			options?.streamingBehavior === "steer" &&
			isHumanInputSource(options.source ?? "interactive");
		if (!observesPrimarySteering) return originalPrompt(text, options);

		const pendingMessageCountBeforePrompt = session.pendingMessageCount;
		const existingPreflightResult = options.preflightResult;
		return originalPrompt(text, {
			...options,
			preflightResult(success) {
				existingPreflightResult?.(success);
				if (success) notifyWhenQueued(pendingMessageCountBeforePrompt);
			},
		});
	};
	const originalSteer = session.steer.bind(session);
	const observedSteer: AgentSession["steer"] = async (text, images, options) => {
		if (!isHumanInputSource(options?.source ?? "interactive")) {
			return originalSteer(text, images, options);
		}
		const pendingMessageCountBeforeSteer = session.pendingMessageCount;
		await originalSteer(text, images, options);
		notifyWhenQueued(pendingMessageCountBeforeSteer);
	};
	session.prompt = observedPrompt;
	session.steer = observedSteer;

	return () => {
		if (session.prompt === observedPrompt) session.prompt = originalPrompt;
		if (session.steer === observedSteer) session.steer = originalSteer;
	};
}
