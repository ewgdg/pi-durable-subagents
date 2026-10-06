import type { EntryPointer } from "./message-delivery.ts";
import type { AgentRunSuspension } from "../runtime/agent-runtime-host.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { RUN_SUSPENSION_NOTICE_CUSTOM_TYPE } from "./custom-entry-types.ts";

export type RunSuspensionNotice = Readonly<{
	notificationId: string;
	agentId: string;
	suspension: AgentRunSuspension;
}>;

export type ModelVisibleRunSuspensionNotice = Readonly<{
	customType: typeof RUN_SUSPENSION_NOTICE_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

/** Tells a headless supervisor that no human will resume its suspended child. */
export function createRunSuspensionNotice(notice: RunSuspensionNotice): ModelVisibleRunSuspensionNotice {
	return {
		customType: RUN_SUSPENSION_NOTICE_CUSTOM_TYPE,
		display: true,
		content: JSON.stringify({ ...notice, guidance:
			"This Agent's exact Run stopped on the suspension in this notice and waits for explicit resumption. This Workflow is headless, so no human will resume it. Its Requests and Answer obligations are retained. After addressing the cause, resume it with agent_control operation \"resume\", abort it with agent_control, or cancel your Request and delegate elsewhere. agent_wait rejects Requests whose responder stays suspended. This notice took no action itself.",
		}),
	};
}

export function inspectRunSuspensionNotice(
	agentId: string, transcript: TranscriptInspection, message: ModelVisibleRunSuspensionNotice,
): EntryPointer | undefined {
	const matches = coordinationEntries(transcript, agentId, `custom:${RUN_SUSPENSION_NOTICE_CUSTOM_TYPE}`)
		.filter(entry => entry.type === "custom_message" && entry.customType === message.customType &&
			entry.content === message.content && entry.display);
	if (matches.length > 1) throw new ProtocolInvariantError("Run suspension notice has duplicate Deliveries");
	return matches[0] ? { agentId, entryId: matches[0].id } : undefined;
}
