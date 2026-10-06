import assert from "node:assert/strict";
import type { AssistantMessage, Context, FauxResponseFactory } from "@earendil-works/pi-ai";

/**
 * The Request a fake responder reads from its own visible Delivery. The JSON scan
 * is deliberate: the tool-schema system message Pi injects also names
 * "requestMessageId" as a field, so raw text matching cannot identify a Delivery.
 */
export function findDeliveredRequest(context: { messages: readonly unknown[] }):
	| { requestMessageId: string; fromAgentId: string }
	| undefined {
	for (const message of [...context.messages as Context["messages"]].reverse()) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			let payload: { messages?: Array<{ kind: string; requestMessageId: string; fromAgentId: string }> };
			try { payload = JSON.parse(part.text); } catch { continue; }
			const request = payload.messages?.findLast(item => item.kind === "request");
			if (request) return request;
		}
	}
	return undefined;
}

/** True when this context carries a delivered Request, as its responder sees it. */
export function hasDeliveredRequest(context: { messages: readonly unknown[] }): boolean {
	return findDeliveredRequest(context) !== undefined;
}

/** Fake responders read the Request ID from the same visible Delivery as a model. */
export function latestRequestFromContext(context: { messages: readonly unknown[] }): { requestMessageId: string; fromAgentId: string } {
	const request = findDeliveredRequest(context);
	if (request) return request;
	assert.fail("Fake responder needs a delivered Request");
}

/**
 * Keeps a fake model call in flight until its caller aborts it, holding an Agent
 * live. A slow streaming rate would also hold it, but the fake provider only
 * observes an abort after each chunk's timer, which then outlives the test.
 */
export function heldUntilAborted(message: AssistantMessage): FauxResponseFactory {
	return (_context, options) => new Promise((resolve) => {
		const signal = options?.signal;
		assert.ok(signal, "A held fake response needs an abortable model call");
		if (signal.aborted) resolve(message);
		else signal.addEventListener("abort", () => resolve(message), { once: true });
	});
}
