import type { AgentQuotaSuspension, QuotaSuspendedNativeInput } from "../runtime/agent-runtime-host.ts";
import type { AgentTranscript } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";

const QUOTA_SUSPENSION_CUSTOM_TYPE = "agent-coordination.quota-suspension";

export type RetainedQuotaSuspension = Readonly<{
	agentId: string;
	runSequence: number;
	suspension: AgentQuotaSuspension;
	nativeInput?: QuotaSuspendedNativeInput;
}>;

/** Owner-transcript journal: unrelated coordination entries never clear execution suspension. */
export class QuotaSuspensionStore {
	readonly #transcript: AgentTranscript;
	readonly #append: (customType: string, data: unknown) => void;

	constructor(options: {
		transcript: AgentTranscript;
		appendCustomEntry(customType: string, data: unknown): void;
	}) {
		this.#transcript = options.transcript;
		this.#append = options.appendCustomEntry;
	}

	current(agentId: string): RetainedQuotaSuspension | undefined {
		const transcript = this.#transcript.inspect();
		let current: RetainedQuotaSuspension | undefined;
		for (const entry of coordinationEntries(transcript, transcript.sessionId, "coordination")) {
			if (entry.type !== "custom" || entry.customType !== QUOTA_SUSPENSION_CUSTOM_TYPE) continue;
			const data = entry.data;
			// A malformed stop cannot safely authorize automatic execution. Fail closed
			// instead of treating unreadable quota state as an ordinary dormant Agent.
			if (!isRecord(data) || typeof data.agentId !== "string" ||
				!Number.isSafeInteger(data.runSequence) || (data.runSequence as number) < 1 ||
				(data.operation !== "suspend" && data.operation !== "clear" && data.operation !== "queue")) {
				throw new Error("evidence_unavailable: invalid quota suspension record");
			}
			if (data.agentId !== agentId) continue;
			if (data.operation === "queue") {
				const queue = data.nativeInput;
				if (!isRecord(queue) || !Array.isArray(queue.steering) || !Array.isArray(queue.followUp) ||
					[...queue.steering, ...queue.followUp].some(item => typeof item !== "string")) {
					throw new Error("evidence_unavailable: invalid suspended native input");
				}
				if (current && current.runSequence === data.runSequence) current = { ...current, nativeInput: queue as QuotaSuspendedNativeInput };
				continue;
			}
			if (data.operation === "clear") {
				if (current?.runSequence === data.runSequence) current = undefined;
				continue;
			}
			const suspension = data.suspension;
			const evidence = isRecord(suspension) && isRecord(suspension.evidence) ? suspension.evidence : undefined;
			if (!isRecord(suspension) || suspension.reason !== "provider_quota" ||
				!evidence || typeof evidence.diagnostic !== "string" ||
				evidence.diagnostic.trim().length === 0 ||
				["provider", "model", "resetAt"].some(key => evidence[key] !== undefined && typeof evidence[key] !== "string")) {
				throw new Error("evidence_unavailable: invalid quota suspension evidence");
			}
			current = { agentId, runSequence: data.runSequence as number, suspension: suspension as AgentQuotaSuspension };
		}
		return current;
	}

	suspend(agentId: string, runSequence: number, suspension: AgentQuotaSuspension, nativeInput?: QuotaSuspendedNativeInput): RetainedQuotaSuspension {
		const existing = this.current(agentId);
		if (existing?.runSequence === runSequence) {
			if (!nativeInput || (nativeInput.steering.length === 0 && nativeInput.followUp.length === 0)) return existing;
			this.#append(QUOTA_SUSPENSION_CUSTOM_TYPE, { operation: "queue", agentId, runSequence, nativeInput });
			return { ...existing, nativeInput };
		}
		this.#append(QUOTA_SUSPENSION_CUSTOM_TYPE, { operation: "suspend", agentId, runSequence, suspension });
		if (nativeInput && (nativeInput.steering.length > 0 || nativeInput.followUp.length > 0)) {
			this.#append(QUOTA_SUSPENSION_CUSTOM_TYPE, { operation: "queue", agentId, runSequence, nativeInput });
			return { agentId, runSequence, suspension, nativeInput };
		}
		return { agentId, runSequence, suspension };
	}

	clear(agentId: string, runSequence: number): void {
		if (this.current(agentId)?.runSequence !== runSequence) return;
		this.#append(QUOTA_SUSPENSION_CUSTOM_TYPE, { operation: "clear", agentId, runSequence });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
