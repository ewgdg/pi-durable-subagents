import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { ModeratorIdentity } from "../protocol/moderator-input.ts";
import type {
	AgentRunState,
	AgentRuntimeHost,
} from "../runtime/agent-runtime-host.ts";
import type {
	AgentRunLaunchConfiguration,
	EffectiveAgentRunConfiguration,
} from "../templates/agent-configuration.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import { AgentTranscript, type TranscriptInspection } from "../transcript/agent-transcript.ts";

export type AgentIdentity = OwnerIdentity | ChildAgentIdentity | ModeratorIdentity;

export type AgentRecord = {
	identity: AgentIdentity;
	creationInput?: AgentSpawnInput;
	/** Derived once from the trusted loaded Identity and creationInput. */
	creationRequest?: Extract<import("../protocol/message.ts").Message, { kind: "request" }>;
	/** Preserves pre-admission model selection while Pi resolves any default thinking level. */
	launchConfiguration?: AgentRunLaunchConfiguration;
	effectiveConfiguration?: EffectiveAgentRunConfiguration;
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot;
	host: AgentRuntimeHost;
	transcript: AgentTranscript;
	children: string[];
};

/** Durable evidence readers do not require a running or simulated Agent host. */
export type AgentEvidence = Pick<AgentRecord,
	"identity" | "creationInput" | "creationRequest" | "transcript" | "children">;

export type AgentStatus = Readonly<{
	agentId: string;
	workflowId: string;
	label: string;
	description?: string;
	directSpawnerAgentId: string | null;
	primaryEvidence: Readonly<{
		transcriptPath: string | null;
		inspectedThrough: Readonly<{
			agentId: string;
			entryId: string;
		}>;
	}>;
	run: AgentRunState;
}>;

export class EvidenceUnavailableError extends Error {
	constructor(message: string) {
		super(`evidence_unavailable: ${message}`);
		this.name = "EvidenceUnavailableError";
	}
}

export function statusOf(
	record: AgentRecord,
	transcript: TranscriptInspection = record.transcript.inspect(),
): AgentStatus {
	const metadata = record.identity.metadata;
	const run: AgentRunState = record.host.observe();
	const transcriptTail = transcript.entries.at(-1);
	if (!transcriptTail) {
		throw new Error(
			`invariant_violation: Agent ${record.identity.agentId} has no transcript evidence`,
		);
	}
	return {
		agentId: record.identity.agentId,
		workflowId: record.identity.workflowId,
		label: metadata.label,
		...(!("description" in metadata) || metadata.description === undefined
			? {}
			: { description: metadata.description }),
		directSpawnerAgentId: record.identity.directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: transcript.transcriptPath,
			inspectedThrough: {
				agentId: record.identity.agentId,
				entryId: transcriptTail.id,
			},
		},
		run,
	};
}

export function requireAgentRecord<Record extends AgentEvidence>(
	agents: ReadonlyMap<string, Record>,
	quarantinedAgentIds: ReadonlySet<string>,
	agentId: string,
): Record {
	const record = agents.get(agentId);
	if (record) return record;
	if (quarantinedAgentIds.has(agentId)) {
		throw new EvidenceUnavailableError(`Agent ${agentId} could not be verified`);
	}
	throw new Error(`unknown_identity: ${agentId}`);
}

/** Catch up before an asynchronous coordination observation, yielding between Agents. */
export async function refreshAgentTranscripts(records: Iterable<AgentRecord>): Promise<void> {
	for (const record of records) await record.transcript.refresh();
}

/** No await may cross this observation: the next event-loop turn must read again. */
export function withAgentTranscriptObservations<T, Record extends AgentEvidence>(records: Iterable<Record>, work: () => T, inspections?: ReadonlyMap<Record, TranscriptInspection>): T {
	return AgentTranscript.withObservations(
		Array.from(records, record => [record.transcript, inspections?.get(record)] as const),
		work,
	);
}
