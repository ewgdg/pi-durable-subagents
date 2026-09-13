import type { ObligationFrame } from "./obligation-focus.ts";

/** Compact navigation for existing Answer obligations, never a task-state record. */
export type OpenIncomingRequest = Readonly<{
	requestMessageId: string;
	requesterAgentId: string;
	title: string;
}>;

export type OpenIncomingRequestList = Readonly<{
	requests: readonly OpenIncomingRequest[];
}>;

export type RequestInspection = OpenIncomingRequest & Readonly<{
	responderAgentId: string;
	question: string;
}>;

export function summarizeRequestObligations(frames: readonly ObligationFrame[]): OpenIncomingRequestList {
	return { requests: frames.map(({ requestId, requesterAgentId, title }) => ({
		requestMessageId: requestId, requesterAgentId, title,
	})) };
}
