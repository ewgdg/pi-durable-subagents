import { ProtocolInvariantError } from "../protocol/identities.ts";

/** Failed admission evidence, retained independently of an admitted coordinator. */
export class OwnerRecoveryError extends Error {
	readonly stage: string;
	readonly agentId: string;
	readonly transcriptPath: string | undefined;
	readonly protocolError: ProtocolInvariantError;
	readonly cleanupError?: unknown;
	constructor(
		stage: string,
		agentId: string,
		transcriptPath: string | undefined,
		protocolError: ProtocolInvariantError,
		cleanupError?: unknown,
	) {
		super("Subagent coordination blocked", { cause: protocolError });
		this.name = "OwnerRecoveryError";
		this.stage = stage;
		this.agentId = agentId;
		this.transcriptPath = transcriptPath;
		this.protocolError = protocolError;
		this.cleanupError = cleanupError;
	}
}
