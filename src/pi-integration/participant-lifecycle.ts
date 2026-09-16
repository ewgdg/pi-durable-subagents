import { REQUEST_ATTENTION_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { obligationStack, type ObligationFrame } from "../protocol/obligation-focus.ts";
import { summarizeRequestObligations } from "../protocol/request-inspection.ts";
import { transcriptFromSessionManager } from "./session-manager-transcript.ts";
import { inspectCoordinationRejections } from "../protocol/replay-rejection.ts";
import { projectOwnerForkBranch, projectOwnerForkCompaction, projectParticipantHistoryContext } from "./owner-fork-context.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
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
	humanInputMode(): Promise<"agent" | "answer" | "quota_suspended">;
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
	let reconciliation: { agentId: string; resolvedRequestIds: Set<string> } | undefined;
	const currentFrames = (transcript: TranscriptInspection, agentId: string) =>
		obligationStack(transcript, agentId).filter(frame =>
			reconciliation?.agentId !== agentId || !reconciliation.resolvedRequestIds.has(frame.requestId));
	// agent_start is the one awaited Pi boundary shared by native prompts,
	// custom Delivery turns, queued continuations, and automatic retries.
	pi.on("agent_start", async (_event, ctx) => {
		const agentId = ctx.sessionManager.getSessionId();
		const local = obligationStack(transcriptFromSessionManager(ctx.sessionManager).inspect(), agentId);
		// Freeze candidates before the coordinator await: a newer Delivery must
		// not be suppressed by an earlier cross-process obligation snapshot.
		const localRequestIds = local.map(frame => frame.requestId);
		const frames = await handlers.executionStarted();
		const owed = new Set(frames.map(frame => frame.requestId));
		// The coordinator can verify requester-side Answer proof before the local
		// author result exists. Reconcile attention for this execution, not durable
		// authority: old focus snapshots must never resurrect or erase obligations.
		reconciliation = { agentId, resolvedRequestIds: new Set(localRequestIds.filter(requestId => !owed.has(requestId))) };
	});
	// Context runs before every generation, including native queued turns and retries.
	// A non-triggering sendMessage at agent_start would not flush until turn_end.
	pi.on("context", (event, ctx) => {
		const transcript = transcriptFromSessionManager(ctx.sessionManager).inspect();
		const agentId = ctx.sessionManager.getSessionId();
		const rejections = inspectCoordinationRejections(transcript, agentId);
		const frames = currentFrames(transcript, agentId);
		// Replace earlier continuation snapshots so resolved Requests are not re-presented.
		const messages = projectParticipantHistoryContext({
			messages: event.messages,
			transcript,
			marks: rejections.map(rejection => ({ reason: rejection.reason,
				record: { ...rejection.source, kind: rejection.recordKind }, diagnostic: rejection.diagnostic })),
		}).filter(message => message.role !== "custom" || message.customType !== REQUEST_ATTENTION_CUSTOM_TYPE);
		return { messages: frames.length
			? [...messages, { role: "custom" as const, ...requestPresentation(frames), timestamp: Date.now() }]
			: messages };
	});
	pi.on("session_before_compact", (event, ctx) => {
		projectOwnerForkCompaction(event.preparation, transcriptFromSessionManager(ctx.sessionManager).inspect());
	});
	pi.on("session_before_tree", (event, ctx) => {
		if (!event.preparation.userWantsSummary) return;
		const customInstructions = projectOwnerForkBranch(event.preparation, transcriptFromSessionManager(ctx.sessionManager).inspect());
		return customInstructions === undefined ? undefined : { customInstructions };
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
				(typeof details?.messageStatus === "string" ||
					(details?.disposition === "committed" && details.delivery === "omitted"));
		});
		await handlers.safeBoundaryReached();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (answeredLastTurn) {
			answeredLastTurn = false;
			const frames = currentFrames(transcriptFromSessionManager(ctx.sessionManager).inspect(), ctx.sessionManager.getSessionId());
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
			"Outstanding Requests.",
			...summary.requests.map(request => `Request: ${request.requestMessageId}\nRequester: ${request.requesterAgentId}\nTitle: ${request.title}`),
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
		if (event.source !== "interactive" || event.streamingBehavior === "followUp") {
			// Pi reports extension event errors without aborting native generation.
			// Block unauthorised input here, before model work, not at agent_start.
			return await handlers.humanInputMode() === "quota_suspended"
				? { action: "handled" } : { action: "continue" };
		}
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
