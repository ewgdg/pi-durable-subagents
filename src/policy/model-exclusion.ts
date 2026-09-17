/**
 * User model exclusions. One entry form names a provider budget for future
 * catalogue additions (`<provider>/*`), the other names one exact identity.
 * Both are validated at policy load so later matching needs no re-checking.
 */

export type ModelIdentity = Readonly<{
	provider: string;
	modelId: string;
}>;

export const PROVIDER_EXCLUSION_WILDCARD = "*";

const ENTRY_RULE =
	'Workflow Policy excludedModels entries must be "<provider>/*" or "<provider>/<modelId>"';

export function modelIdentity(identity: ModelIdentity): string {
	return `${identity.provider}/${identity.modelId}`;
}

export function providerExclusionEntry(provider: string): string {
	return `${provider}/${PROVIDER_EXCLUSION_WILDCARD}`;
}

export function parseExcludedModels(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		throw new Error(`Workflow Policy excludedModels must be a sequence; ${ENTRY_RULE}`);
	}
	const entries = value.map((entry) => {
		if (typeof entry !== "string") throw new Error(ENTRY_RULE);
		assertExclusionEntry(entry);
		return entry;
	});
	if (new Set(entries).size !== entries.length) {
		throw new Error("Workflow Policy excludedModels contains a duplicate entry");
	}
	return Object.freeze(entries);
}

export function isProviderExclusionEntry(entry: string): boolean {
	return entry.endsWith(`/${PROVIDER_EXCLUSION_WILDCARD}`);
}

/** Entries are validated at load; this split cannot fail for a parsed snapshot. */
export function excludedProvider(entry: string): string {
	return entry.slice(0, entry.indexOf("/"));
}

/** Matching is a union of both entry forms; there is no negation. */
export function isModelExcluded(
	entries: readonly string[],
	identity: ModelIdentity,
): boolean {
	const candidate = modelIdentity(identity);
	return entries.some((entry) => entry === candidate
		|| (isProviderExclusionEntry(entry) && excludedProvider(entry) === identity.provider));
}

function assertExclusionEntry(entry: string): void {
	const separator = entry.indexOf("/");
	if (separator <= 0) throw new Error(ENTRY_RULE);
	const provider = entry.slice(0, separator);
	const modelId = entry.slice(separator + 1);
	// A model id may itself contain slashes, so only the first separator is structural.
	const validModelId = modelId === PROVIDER_EXCLUSION_WILDCARD
		|| modelId.split("/").every(isValidSegment);
	if (!isValidSegment(provider) || !validModelId) throw new Error(ENTRY_RULE);
}

function isValidSegment(segment: string): boolean {
	return segment.length > 0 && !/[\s*]/.test(segment);
}
