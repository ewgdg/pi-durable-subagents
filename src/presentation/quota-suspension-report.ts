import type { ReportToUserInput } from "../protocol/moderator-report.ts";
import type { QuotaEvidence } from "../runtime/quota-evidence.ts";

export function createQuotaSuspensionReport(input: Readonly<{
	agentId: string;
	label: string;
	runSequence: number;
	evidence: QuotaEvidence;
}>): ReportToUserInput {
	const { evidence } = input;
	return {
		symptom: `Suspended · Usage limit reached · ${input.label} · Run ${input.runSequence}`,
		suspectedDefect: "The provider reported exhausted quota after Pi's configured native recovery finished. This is a resource block, not a diagnosed coordination defect.",
		uncertainty: "Only this Run is suspended. Other accounts and Runs are not presumed blocked. Quota recovery is not verified; no reset time is inferred.",
		recoveryActions: "Restore quota or deliberately change the model/account, then explicitly resume. Use agent_control resume for a supervised child, or /quota-resume for the Owner. No automatic retry or paid fallback is introduced.",
		recoveryOutcome: "The Run, Requests, Answer Obligations, and queued work are retained. Reading this notice does not resume work, cancel Requests, or establish quota recovery.",
		evidence: [
			`Agent: ${input.label} (${input.agentId})`,
			`Run: ${input.runSequence}`,
			...(evidence.provider === undefined ? [] : [`Provider: ${evidence.provider}`]),
			...(evidence.model === undefined ? [] : [`Model: ${evidence.model}`]),
			`Diagnostic: ${evidence.diagnostic}`,
			...(evidence.resetAt === undefined ? [] : [`Reset time: ${evidence.resetAt}`]),
		],
	};
}
