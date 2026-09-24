/** Failed admission evidence, retained independently of an admitted coordinator. */
export class OwnerRecoveryError extends Error {
	readonly stage: string;
	readonly agentId: string;
	readonly transcriptPath: string | undefined;
	readonly admissionError: unknown;
	readonly cleanupError?: unknown;
	constructor(
		stage: string,
		agentId: string,
		transcriptPath: string | undefined,
		admissionError: unknown,
		cleanupError?: unknown,
	) {
		super("Subagent coordination blocked", { cause: admissionError });
		this.name = "OwnerRecoveryError";
		this.stage = stage;
		this.agentId = agentId;
		this.transcriptPath = transcriptPath;
		this.admissionError = admissionError;
		this.cleanupError = cleanupError;
	}
}
