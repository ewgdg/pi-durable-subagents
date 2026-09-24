import { REQUEST_ATTENTION_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { MESSAGE_DELIVERY_CUSTOM_TYPE } from "../protocol/message-delivery.ts";
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
	SessionBoundaryDraft,
	TurnEndEvent,
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
	humanInputMode(): Promise<"agent" | "answer" | "run_suspended">;
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
	// One sticky, once-consumed continuation per execution. A committed Answer ends its
	// model/tool loop, and a committed `agent_wait` aggregate delivers its Answers
	// mid-loop rather than ending it; either way the execution owes one boundary-supplied
	// continuation when it settles. The flag survives the Answer-free generations in
	// between and is consumed at agent_before_settle.
	let answerDelivered = false;
	const currentFrames = (transcript: TranscriptInspection, agentId: string) =>
		obligationStack(transcript, agentId).filter(frame =>
			reconciliation?.agentId !== agentId || !reconciliation.resolvedRequestIds.has(frame.requestId));
	// agent_start is the one awaited Pi boundary shared by native prompts,
	// custom Delivery turns, queued continuations, and automatic retries.
	pi.on("agent_start", async (_event, ctx) => {
		const agentId = ctx.sessionManager.getSessionId();
		// Freeze candidates before the coordinator await: a newer Delivery must
		// not be suppressed by an earlier cross-process obligation snapshot.
		const localRequestIds = freezeLocalRequestIds(ctx.sessionManager, agentId);
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
		// A fresh Delivery must stay the newest model-visible message. Pi renders
		// custom messages as user-role content, so appending this presentation would
		// hide the Delivery that triggered the turn and starve the model of its task.
		if (!frames.length) return { messages };
		const presentation = {
			role: "custom" as const,
			...requestPresentation(frames),
			timestamp: Date.now(),
		};
		const deliveryIndex = messages.findLastIndex(message =>
			message.role === "custom" && message.customType === MESSAGE_DELIVERY_CUSTOM_TYPE);
		return {
			messages: deliveryIndex < 0
				? [...messages, presentation]
				: [
					...messages.slice(0, deliveryIndex),
					presentation,
					...messages.slice(deliveryIndex),
				],
		};
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
		// Native input reaching the model after an Answer-delivering turn is itself that
		// continuation opportunity (docs/agent-messaging.md), and it is always consumed by
		// a generation, so the runtime must not offer a second continuation at settlement.
		if (event.message.role === "user") answerDelivered = false;
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
	// Pi awaits turn_end after the complete issued tool batch and before it builds
	// the next model context, making this the Steer freeze boundary. Only a turn
	// with tool results continues to another model turn; a final turn leaves Steer
	// to agent_before_settle, and awaiting the Owner there would keep the native
	// session busy after the Owner already observes it settled. Run disposal
	// cannot deadlock here: reachSafeBoundary skips the lane once a Run is ending
	// or interrupting (see src/coordination/messages.ts).
	pi.on("turn_end", async (event, ctx) => {
		if (event.toolResults.some(deliveredAnswer)) answerDelivered = true;
		if (event.toolResults.length > 0) await handlers.safeBoundaryReached();
		const transcript = transcriptFromSessionManager(ctx.sessionManager).inspect();
		const frames = currentFrames(transcript, ctx.sessionManager.getSessionId());
		const hides = resolvedAttentionEdits(transcript, frames, false);
		return hides.length ? { entries: hides } : undefined;
	});
	// agent_before_settle fires after Pi drains queues and before settlement; its
	// boundary covers work that arrived after the last turn_end. A returned
	// continue:true requests one next provider request when canContinue.
	// This replaces the former agent_end + sendMessage(steer, triggerTurn) loop.
	pi.on("agent_before_settle", async (event, ctx) => {
		await handlers.safeBoundaryReached();
		if (!answerDelivered) return undefined;
		answerDelivered = false;
		const transcript = transcriptFromSessionManager(ctx.sessionManager).inspect();
		const frames = currentFrames(transcript, ctx.sessionManager.getSessionId());
		// Answer ends its model/tool loop. Offer remaining work once, unless native
		// input already provides a continuation; never choose the next task or spin at settlement.
		if (!frames.length || ctx.hasPendingMessages()) {
			const hides = resolvedAttentionEdits(transcript, frames, false);
			return hides.length ? { entries: hides } : undefined;
		}
		const entries: SessionBoundaryDraft[] = [
			...resolvedAttentionEdits(transcript, frames, true),
			{ type: "custom_message", ...requestPresentation(frames) },
		];
		if (!event.context.canContinue) {
			// A continuation request would be invalid here (canContinue is false whenever
			// the last projected message is assistant-role: the normal end for a
			// non-terminating Answer plus wrap-up reply (agent-session.js
			// _buildBoundaryContext), not a turn limit. Keep no-continue + retain the
			// snapshot so the next native input resumes with full attention.
			ctx.ui.notify("Remaining work retained without continuation: the turn ended on an assistant message with no queued input.", "warning");
			return { entries };
		}
		return { entries, continue: true };
	});
	pi.on("agent_end", async () => {
		await handlers.executionEnded();
	});
}

/**
 * A turn result that proves an Answer reached its requester. A terminating
 * `agent_message` commitment carries its receipt, while a committed `agent_wait`
 * aggregate is itself the requester-side Delivery proof for each Answer it
 * returns; `answer_already_delivered` only repeats prior proof.
 */
function deliveredAnswer(result: TurnEndEvent["toolResults"][number]): boolean {
	if (result.isError) return false;
	const details = result.details as Record<string, unknown> | undefined;
	if (result.toolName === "agent_message") {
		return typeof details?.requestMessageId === "string" && typeof details?.messageId === "string" &&
			(typeof details?.messageStatus === "string" ||
				(details?.disposition === "committed" && details.delivery === "omitted"));
	}
	if (result.toolName !== "agent_wait") return false;
	return Array.isArray(details?.answers) && details.answers.some(answer =>
		(answer as Record<string, unknown> | null | undefined)?.disposition === "answer_delivered");
}

/**
 * Local attention candidates frozen for one execution. The Owner's admission stays
 * authoritative for durable obligation, so a transcript this Run cannot inspect yet
 * (an Agent whose Identity entry has not committed) yields no candidates instead of
 * suppressing the execution intention the Owner is waiting to admit.
 */
function freezeLocalRequestIds(
	sessionManager: ExtensionContext["sessionManager"],
	agentId: string,
): string[] {
	try {
		return obligationStack(transcriptFromSessionManager(sessionManager).inspect(), agentId)
			.map(frame => frame.requestId);
	} catch {
		return [];
	}
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

/** Append-only hides for committed attention snapshots this execution supersedes. */
function resolvedAttentionEdits(
	transcript: TranscriptInspection,
	frames: readonly ObligationFrame[],
	supersedeAll: boolean,
): SessionBoundaryDraft[] {
	const owed = new Set(frames.map(frame => frame.requestId));
	const edits: SessionBoundaryDraft[] = [];
	// Model context is unaffected by repeats (last edit per target wins) but the
	// session file grows per boundary. Skip targets that already carry an effective
	// hide so repeated turn_end/before_settle pairs emit no new draft.
	const hiddenByTarget = new Map<string, { replacement: unknown }>();
	for (const entry of transcript.activeBranch) {
		if (entry.type !== "context_edit") continue;
		hiddenByTarget.set(entry.targetId, entry);
	}
	// Pi validates drafts against [header, ...getBranch()]: an off-branch target
	// discards the whole proposal, losing hides and continue. Scan only the
	// active branch so navigation never turns settlement into a silent stop.
	for (const entry of transcript.activeBranch) {
		if (entry.type !== "custom_message" || entry.customType !== REQUEST_ATTENTION_CUSTOM_TYPE) continue;
		const requests = (entry.details as { requests?: readonly { requestMessageId?: unknown }[] } | undefined)?.requests;
		if (!Array.isArray(requests)) continue;
		const resolved = requests.every(request => typeof request.requestMessageId !== "string" || !owed.has(request.requestMessageId));
		// A fresh snapshot replaces earlier ones even when work is still owed;
		// otherwise only fully resolved snapshots may leave model context.
		if (!(supersedeAll || resolved)) continue;
		// Skip already-hidden targets: Pi keeps the last edit per target, so a
		// committed null replacement already omits this snapshot from model context.
		if (hiddenByTarget.get(entry.id)?.replacement === null) continue;
		edits.push({ type: "context_edit", targetId: entry.id, replacement: null });
	}
	return edits;
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
			return await handlers.humanInputMode() === "run_suspended"
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
