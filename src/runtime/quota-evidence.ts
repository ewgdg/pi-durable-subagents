export type QuotaEvidence = Readonly<{
	diagnostic: string;
	provider?: string;
	model?: string;
	resetAt?: string;
}>;

/**
 * Classify only retained provider evidence, never HTTP status or generic limit prose.
 * Pi currently exposes AssistantMessage.errorMessage, not the original provider error.
 * Upstream must carry structured code/type and absolute reset time through provider
 * catches into AssistantMessage to recover evidence lost by formatting. In particular,
 * CodexApiError.payload/code are discarded; its HTTP friendly text conflates quota,
 * temporary rate limits, and generic 429s. That friendly text is deliberately excluded.
 */
export function classifyQuotaEvidence(assistant: Readonly<{
	errorMessage?: string; provider?: string; model?: string;
}>): QuotaEvidence | undefined {
	const diagnostic = assistant.errorMessage;
	if (!diagnostic) return undefined;
	let error: Record<string, unknown> | undefined;
	try {
		// Pi's formatProviderError can retain the JSON body after a status prefix.
		// Strip only that formatter shape; the status is never quota evidence.
		const parsed: unknown = JSON.parse(diagnostic.replace(/^\d{3}: /, ""));
		if (isRecord(parsed)) error = isRecord(parsed.error) ? parsed.error : parsed;
	} catch {
		// Pi normally flattens provider failures to prose, not JSON.
	}
	const code = typeof error?.code === "string" ? error.code
		: typeof error?.type === "string" ? error.type : undefined;
	if (code !== undefined) {
		if (code !== "usage_limit_reached" && code !== "insufficient_quota") return undefined;
	} else if (diagnostic !== "Codex error: The usage limit has been reached" ||
		(assistant.provider !== undefined && assistant.provider !== "openai-codex")) {
		return undefined;
	}
	// resets_at is the provider's absolute Unix-seconds field; do not infer from retry hints.
	const resetMillis = typeof error?.resets_at === "number" ? error.resets_at * 1000 : NaN;
	const reset = new Date(resetMillis);
	return {
		diagnostic,
		...(assistant.provider !== undefined ? { provider: assistant.provider } : {}),
		...(assistant.model !== undefined ? { model: assistant.model } : {}),
		...(Number.isFinite(reset.getTime()) ? { resetAt: reset.toISOString() } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
