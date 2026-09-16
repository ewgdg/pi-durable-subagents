import { requireAgentRecord, type AgentEvidence } from "./agent-record.ts";
import { RequestEvidence } from "./request-evidence.ts";
import type { WorkflowResumeDelivery } from "./workflow-recovery-outcomes.ts";
import { findAuthoredAgentMessageSources, inspectCanonicalRequestResolution } from "../protocol/request-resolution.ts";
import { compareCommittedToolCallOrder, deriveMessageIdentity } from "../protocol/identities.ts";
import { findAuthoredSupervisoryResumeMessages } from "../protocol/run-control.ts";
import { inspectAnswerDelivery, inspectCanonicalMessage, inspectMessageDelivery, type Message } from "../protocol/message.ts";

/** The durable selection shared by explicit recovery and offline repair audits. Never schedules work. */
export class WorkflowRecoveryEvidence {
	readonly requests: RequestEvidence;
	readonly agents: ReadonlyMap<string, AgentEvidence>;
	readonly quarantinedAgentIds: ReadonlySet<string>;
	constructor(agents: ReadonlyMap<string, AgentEvidence>, requests?: RequestEvidence,
		quarantinedAgentIds: ReadonlySet<string> = new Set()) {
		this.agents = agents;
		this.quarantinedAgentIds = quarantinedAgentIds;
		this.requests = requests ?? new RequestEvidence(new Map(agents));
	}

	messageCandidates(record: AgentEvidence): readonly { messageId: string; authorAgentId: string }[] {
		const transcript = record.transcript.inspect();
		return [
			...findAuthoredAgentMessageSources({ authorAgentId: record.identity.agentId, transcript }).map(({ source }) => source),
			...findAuthoredSupervisoryResumeMessages({ workflowId: record.identity.workflowId, authorAgentId: record.identity.agentId, transcript }).map(message => message.source),
			...[...this.agents.values()].flatMap(child =>
				"spawnSource" in child.identity && child.identity.directSpawnerAgentId === record.identity.agentId
					? [child.identity.spawnSource] : []),
		].sort((a, b) => compareCommittedToolCallOrder(transcript, a, b))
			.map(source => ({ messageId: deriveMessageIdentity(source), authorAgentId: record.identity.agentId }));
	}

	message(authorAgentId: string, messageId: string): Message | undefined {
		const author = this.requireAgent(authorAgentId);
		return findAuthoredSupervisoryResumeMessages({
			workflowId: author.identity.workflowId, authorAgentId, transcript: author.transcript.inspect(),
		}).find(message => message.messageId === messageId) ?? this.requests.resolveRecoveryMessage(author, messageId);
	}

	requestIds(record: AgentEvidence): readonly string[] {
		return this.requests.obligationFrames(record).flatMap(frame => {
			const request = this.requests.findRequest(frame.requestId);
			if (!request) return [frame.requestId];
			const resolution = this.resolution(request);
			return resolution.cancellation || resolution.answer ? [] : [frame.requestId];
		});
	}

	inspectMessage(message: Message): WorkflowResumeDelivery | undefined {
		const recipient = this.requireAgent(message.targetAgentId);
		const identity = { messageId: message.messageId, targetAgentId: message.targetAgentId, kind: message.kind };
		const delivery = message.kind === "answer"
			? inspectAnswerDelivery({ requesterAgentId: message.targetAgentId, transcript: recipient.transcript.inspect(), answer: message })
			: inspectMessageDelivery({ recipientAgentId: message.targetAgentId, transcript: recipient.transcript.inspect(), message });
		const canonical = inspectCanonicalMessage({ message,
			authorTranscript: this.requireAgent(message.fromAgentId).transcript.inspect(), deliveryEvidence: delivery.deliveryEvidence });
		if (canonical.state === "not_created") return { ...identity, disposition: "skipped", reason: "not_created" };
		if (canonical.state === "indeterminate") return { ...identity, disposition: "indeterminate", reason: "inspection_incomplete" };
		const resolution = message.kind === "request" ? this.resolution(message) : undefined;
		if (resolution?.cancellation || resolution?.answer) return { ...identity, disposition: "skipped", reason: "request_resolved" };
		if (delivery.deliveryEvidence) return { ...identity, disposition: "skipped", reason: "delivered" };
		return undefined;
	}

	private resolution(request: Extract<Message, { kind: "request" }>) {
		return inspectCanonicalRequestResolution({ request,
			requesterTranscript: this.requireAgent(request.fromAgentId).transcript.inspect(),
			responderTranscript: this.requireAgent(request.targetAgentId).transcript.inspect() });
	}
	private requireAgent(agentId: string): AgentEvidence {
		return requireAgentRecord(this.agents, this.quarantinedAgentIds, agentId);
	}
}
