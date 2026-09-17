import type { AgentSessionRuntimeDiagnostic } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";

export type WorkflowPolicySnapshot = Readonly<{
	maxConcurrentAgentRuns: number;
	maxPendingDeliveriesPerAgent: number;
	operationReviewIntervalMs: number;
	deliveryProgressIntervalMs: number;
}>;

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicySnapshot = Object.freeze({
	maxConcurrentAgentRuns: 8,
	maxPendingDeliveriesPerAgent: 256,
	operationReviewIntervalMs: 600_000,
	deliveryProgressIntervalMs: 60_000,
});

const POLICY_FIELDS = new Set<keyof WorkflowPolicySnapshot>([
	"maxConcurrentAgentRuns",
	"maxPendingDeliveriesPerAgent",
	"operationReviewIntervalMs",
	"deliveryProgressIntervalMs",
]);
const MINIMUM_INTERVAL_MS = 1_000;
const MAXIMUM_INTERVAL_MS = 2_147_483_647;
const POLICY_DIRECTORY = "config";
const POLICY_FILENAME = "pi-durable-subagents.json";

export type WorkflowPolicyReadResult =
	| Readonly<{
		ok: true;
		snapshot: WorkflowPolicySnapshot;
	}>
	| Readonly<{
		ok: false;
		diagnostic: AgentSessionRuntimeDiagnostic;
	}>;

export class WorkflowPolicyStore {
	#snapshot: WorkflowPolicySnapshot;

	constructor(initial: WorkflowPolicySnapshot = DEFAULT_WORKFLOW_POLICY) {
		assertCompleteWorkflowPolicy(initial);
		this.#snapshot = initial;
	}

	current(): WorkflowPolicySnapshot {
		return this.#snapshot;
	}

	publish(snapshot: WorkflowPolicySnapshot): void {
		assertCompleteWorkflowPolicy(snapshot);
		this.#snapshot = snapshot;
	}
}

export function parseWorkflowPolicy(source: string): WorkflowPolicySnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error("Workflow Policy must be strict JSON");
	}
	// JSON.parse discards duplicate-key evidence, so validate key uniqueness separately.
	const document = parseDocument(source, { schema: "json", uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new Error("Workflow Policy mapping keys must be unique");
	}
	if (!isPlainRecord(parsed)) {
		throw new Error("Workflow Policy must be one JSON object");
	}
	for (const field of Object.keys(parsed)) {
		if (!POLICY_FIELDS.has(field as keyof WorkflowPolicySnapshot)) {
			throw new Error(`Workflow Policy contains unknown field ${JSON.stringify(field)}`);
		}
	}

	const snapshot = Object.freeze({
		maxConcurrentAgentRuns: parsePositiveSafeInteger(
			"maxConcurrentAgentRuns",
			policyValueOrDefault(parsed, "maxConcurrentAgentRuns"),
		),
		maxPendingDeliveriesPerAgent: parsePositiveSafeInteger(
			"maxPendingDeliveriesPerAgent",
			policyValueOrDefault(parsed, "maxPendingDeliveriesPerAgent"),
		),
		deliveryProgressIntervalMs: parseBoundedInterval(
			policyValueOrDefault(parsed, "deliveryProgressIntervalMs"), "deliveryProgressIntervalMs",
		),
		operationReviewIntervalMs: parseBoundedInterval(
			policyValueOrDefault(parsed, "operationReviewIntervalMs"),
		),
	});
	return snapshot;
}

export async function readWorkflowPolicy(
	agentDir: string,
): Promise<WorkflowPolicyReadResult> {
	const path = join(agentDir, POLICY_DIRECTORY, POLICY_FILENAME);
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		if (isMissingFile(error)) {
			return { ok: true, snapshot: DEFAULT_WORKFLOW_POLICY };
		}
		return invalidRead("Workflow Policy could not be read");
	}
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return invalidRead("Workflow Policy must be valid UTF-8");
	}
	try {
		return { ok: true, snapshot: parseWorkflowPolicy(source) };
	} catch (error) {
		return invalidRead(
			error instanceof Error ? error.message : "Workflow Policy is invalid",
		);
	}
}

function policyValueOrDefault(
	policy: Record<string, unknown>,
	field: keyof WorkflowPolicySnapshot,
): unknown {
	return Object.hasOwn(policy, field) ? policy[field] : DEFAULT_WORKFLOW_POLICY[field];
}

function parsePositiveSafeInteger(field: string, value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`Workflow Policy ${field} must be a positive safe integer`);
	}
	return value as number;
}

function parseBoundedInterval(value: unknown, field = "operationReviewIntervalMs"): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < MINIMUM_INTERVAL_MS ||
		(value as number) > MAXIMUM_INTERVAL_MS
	) {
		throw new Error(
			`Workflow Policy ${field} must be an integer from ${MINIMUM_INTERVAL_MS} through ${MAXIMUM_INTERVAL_MS}`,
		);
	}
	return value as number;
}

function assertCompleteWorkflowPolicy(snapshot: WorkflowPolicySnapshot): void {
	parsePositiveSafeInteger("maxConcurrentAgentRuns", snapshot.maxConcurrentAgentRuns);
	parsePositiveSafeInteger(
		"maxPendingDeliveriesPerAgent",
		snapshot.maxPendingDeliveriesPerAgent,
	);
	parseBoundedInterval(snapshot.operationReviewIntervalMs);
	parseBoundedInterval(snapshot.deliveryProgressIntervalMs, "deliveryProgressIntervalMs");
	if (!Object.isFrozen(snapshot)) {
		throw new Error("Workflow Policy snapshots must be immutable");
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invalidRead(message: string): WorkflowPolicyReadResult {
	return {
		ok: false,
		diagnostic: { type: "error", message },
	};
}
