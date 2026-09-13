import { REQUEST_ATTENTION_CUSTOM_TYPE, OBLIGATION_FOCUS_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { obligationStack, type ObligationFrame } from "../protocol/obligation-focus.ts";
import { summarizeRequestObligations } from "../protocol/request-inspection.ts";
import { transcriptFromSessionManager } from "./session-manager-transcript.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

export type ParticipantHumanInput = Readonly<{
	text: string;
	images: InputEvent["images"];
	submissionSequence?: number;
}>;

export type ParticipantHumanInputDisposition = "continue" | "submitted" | "discarded";

export type ParticipantToolResult = Readonly<{
	message: MessageEndEvent["message"];
}>;

export type ParticipantToolExecution = Readonly<{
	toolCallId: string;
	toolName: string;
}>;

export type GuardedParticipantToolResult = Readonly<{
	message?: MessageEndEvent["message"];
	rejectedAnswer?: string;
	reason?: string;
}>;

export type ParticipantLifecycleHandlers = Readonly<{
	executionStarted(submissionSequence?: number): Promise<readonly ObligationFrame[]>;
	humanInputSubmitted(input: ParticipantHumanInput): Promise<ParticipantHumanInputDisposition>;
	primaryInputQueued(): Promise<void>;
	humanInputMode(): Promise<"agent" | "answer">;
	toolResultCommitting(
		input: ParticipantToolResult,
	): Promise<GuardedParticipantToolResult | undefined>;
	toolExecutionStarted(input: ParticipantToolExecution): Promise<void>;
	safeBoundaryReached(): Promise<void>;
	executionEnded(): Promise<void>;
}>;

/** Bind Pi lifecycle events to process-neutral participant intentions. */
export function registerParticipantLifecycle(
	pi: ExtensionAPI,
	handlers: ParticipantLifecycleHandlers,
	options: Readonly<{
		registerInput?: boolean;
		deferPrimaryInputQueued?: boolean;
	}> = {},
): void {
	// agent_start is the one awaited Pi boundary shared by native prompts,
	// custom Delivery turns, queued continuations, and automatic retries.
	pi.on("agent_start", async (_event, ctx) => {
		const frames = await handlers.executionStarted();
		const local = obligationStack(transcriptFromSessionManager(ctx.sessionManager).inspect(), ctx.sessionManager.getSessionId());
		if (JSON.stringify(local) !== JSON.stringify(frames)) {
			// A requester may prove an Answer before its responder's result appended.
			// Record that recovery boundary locally before any new model authorship.
			pi.appendEntry(OBLIGATION_FOCUS_CUSTOM_TYPE, { frames });
		}
	});
	// Context runs before every generation, including native queued turns and retries.
	// A non-triggering sendMessage at agent_start would not flush until turn_end.
	pi.on("context", (event, ctx) => {
		const frames = obligationStack(transcriptFromSessionManager(ctx.sessionManager).inspect(), ctx.sessionManager.getSessionId());
		// Replace earlier continuation snapshots so resolved Requests are not re-presented.
		const messages = event.messages.filter(message =>
			message.role !== "custom" || message.customType !== REQUEST_ATTENTION_CUSTOM_TYPE);
		return { messages: frames.length
			? [...messages, { role: "custom" as const, ...requestPresentation(frames), timestamp: Date.now() }]
			: messages };
	});
	if (options.registerInput !== false) {
		registerParticipantInputLifecycle(pi, handlers, {
			deferPrimaryInputQueued: options.deferPrimaryInputQueued,
		});
	}
	// message_end is Pi's final awaited hook before it synchronously publishes the
	// native result. A Run fence can still turn a submitted candidate into the one
	// interruption result here; attention remains until later transcript proof.
	pi.on("message_end", async (event, ctx) => {
		const guarded = await handlers.toolResultCommitting({
			message: event.message,
		});
		if (!guarded) return;
		if (guarded.rejectedAnswer !== undefined) {
			const currentDraft = ctx.ui.getEditorText();
			if (currentDraft !== guarded.rejectedAnswer) {
				// The editor remains usable during result commitment. Restore the
				// rejected candidate without discarding text typed after submission.
				ctx.ui.setEditorText(
					currentDraft.length === 0
						? guarded.rejectedAnswer
						: `${guarded.rejectedAnswer}\n${currentDraft}`,
				);
			}
			ctx.ui.notify(
				`Human Answer was not committed: ${guarded.reason ?? "the request ended"}`,
				"error",
			);
		}
		return guarded.message ? { message: guarded.message } : undefined;
	});
	pi.on("tool_execution_start", (event) =>
		handlers.toolExecutionStarted({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		})
	);
	// Pi awaits turn_end only after the complete issued tool batch and before it
	// constructs the next model context, making this the Steer freeze boundary.
	let answeredLastTurn = false;
	// Native queued input can run after a terminating Answer in the same execution.
	// Only the last turn can still need a runtime-supplied continuation.
	pi.on("turn_end", async (event) => {
		answeredLastTurn = event.toolResults.some(result => {
			const details = result.details as Record<string, unknown> | undefined;
			return result.toolName === "agent_message" && !result.isError &&
				typeof details?.requestMessageId === "string" && typeof details?.messageId === "string" &&
				typeof details?.messageStatus === "string";
		});
		await handlers.safeBoundaryReached();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (answeredLastTurn) {
			answeredLastTurn = false;
			const frames = obligationStack(transcriptFromSessionManager(ctx.sessionManager).inspect(), ctx.sessionManager.getSessionId());
			// Answer ends its model/tool loop. Offer remaining work once, unless native
			// input already provides a continuation; never choose the next task or spin at settlement.
			if (frames.length && !ctx.hasPendingMessages()) presentRequests(pi, frames, true);
		}
		await handlers.executionEnded();
	});
}

function requestPresentation(frames: readonly ObligationFrame[]) {
	const summary = summarizeRequestObligations(frames);
	return {
		customType: REQUEST_ATTENTION_CUSTOM_TYPE,
		display: true,
		content: [
			"Open incoming Requests. Choose which to work on or answer; attention order does not prescribe execution order.",
			...summary.requests.map(request => `Request: ${request.requestMessageId}\nRequester: ${request.requesterAgentId}\nTitle: ${request.title}`),
			"Use agent_observe operation \"request\" with requestId to inspect full instructions when they are no longer in context. A title is not the full Request.",
		].join("\n\n"),
		details: summary,
	};
}

function presentRequests(pi: ExtensionAPI, frames: readonly ObligationFrame[], triggerTurn: boolean): void {
	pi.sendMessage(requestPresentation(frames), { deliverAs: "steer", triggerTurn });
}

export function registerParticipantInputLifecycle(
	pi: ExtensionAPI,
	handlers: ParticipantLifecycleHandlers,
	options: Readonly<{ deferPrimaryInputQueued?: boolean }> = {},
): void {
	pi.on(
		"input",
		createParticipantInputHandler(handlers, () => Promise.resolve(), options),
	);
}

export function createParticipantInputHandler(
	handlers: ParticipantLifecycleHandlers,
	onDiscarded: () => Promise<void> = () => Promise.resolve(),
	options: Readonly<{ deferPrimaryInputQueued?: boolean }> = {},
): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> {
	return async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (event.streamingBehavior === "followUp") return { action: "continue" };
		try {
			const disposition = await handlers.humanInputSubmitted({
				text: event.text,
				images: event.images,
			});
			if (disposition === "discarded") await onDiscarded();
			if (
				disposition === "continue" &&
				event.streamingBehavior === "steer" &&
				options.deferPrimaryInputQueued !== false
			) deferPrimaryInputQueued(handlers, ctx);
			return disposition === "continue"
				? { action: "continue" }
				: { action: "handled" };
		} catch (error) {
			const answeringHumanRequest = await handlers.humanInputMode() === "answer";
			if (answeringHumanRequest) ctx.ui.setEditorText(event.text);
			ctx.ui.notify(
				`${answeringHumanRequest ? "Human Answer was not submitted" : "Agent input failed"}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "handled" };
		}
	};
}

export function deferPrimaryInputQueued(
	handlers: ParticipantLifecycleHandlers,
	ctx: ExtensionContext,
): void {
	// Pi queues steering only after every input handler returns. Defer the wait
	// preemption so its tool result cannot outrun this user message.
	setImmediate(() => {
		void handlers.primaryInputQueued().catch((error: unknown) => {
			ctx.ui.notify(
				`Agent input failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
	});
}
