/**
 * User Virtual Models: a named, ordered list of real model and thinking pairs,
 * selectable as `virtual/<name>`. Pi routes each request of a virtual selection
 * through our router, which picks the first usable entry. Definitions are
 * validated at policy load so routing needs no re-checking.
 */
import type { ModelReference, RuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import { isRuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import { isAgentTemplateName } from "../templates/agent-template-name.ts";
import { modelIdentity, type ModelPolicySnapshot } from "./model-exclusion.ts";

/** Pi lists a virtual model under an unused provider id as always available. */
export const VIRTUAL_MODEL_PROVIDER = "virtual";

export type VirtualModelEntry = Readonly<{
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
}>;

export type VirtualModelDefinitions = Readonly<Record<string, readonly VirtualModelEntry[]>>;

/**
 * What the Config tab edits: the policy file's definitions, or the Owner's last
 * valid ones while the file is invalid, plus what decides entry usability.
 */
export type VirtualModelConfigSnapshot = ModelPolicySnapshot & Readonly<{
	virtualModels: VirtualModelDefinitions;
	/** Why the policy file cannot be read; editing is disabled while it is set. */
	invalidReason?: string;
}>;

/** Why an entry cannot serve a request right now. */
export type EntryUsability = "usable" | "excluded" | "unavailable";

const ENTRY_RULE =
	"Workflow Policy virtualModels entries must contain only id (a real \"<provider>/<modelId>\") and thinking";

export function isVirtualModel(model: ModelReference): boolean {
	return model.provider === VIRTUAL_MODEL_PROVIDER;
}

export function parseVirtualModels(value: unknown): VirtualModelDefinitions {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Workflow Policy virtualModels must be an object of named entry lists");
	}
	const definitions: Record<string, readonly VirtualModelEntry[]> = {};
	for (const [name, entries] of Object.entries(value)) {
		if (!isAgentTemplateName(name)) {
			throw new Error(`Workflow Policy virtual model name ${JSON.stringify(name)} must be lowercase kebab-case`);
		}
		definitions[name] = parseEntries(name, entries);
	}
	return Object.freeze(definitions);
}

export function requireVirtualModelDefinition(
	definitions: VirtualModelDefinitions,
	name: string,
): readonly VirtualModelEntry[] {
	const entries = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
	if (entries === undefined) {
		throw new Error(`Virtual model ${VIRTUAL_MODEL_PROVIDER}/${name} is not defined in the Workflow Policy`);
	}
	return entries;
}

/**
 * Picks the entry that serves one request. A sticky model (the model of the
 * previous response for a continuation, or the failed one for a retry) wins while
 * it is still a usable entry, so prompt caches and thinking signatures stay valid.
 * Otherwise the first usable entry wins. Throws when no entry is usable.
 */
export function selectVirtualModelEntry(options: Readonly<{
	name: string;
	entries: readonly VirtualModelEntry[];
	usability: (model: ModelReference) => EntryUsability;
	sticky?: ModelReference;
}>): VirtualModelEntry {
	const { name, entries, usability, sticky } = options;
	const stickyEntry = sticky === undefined
		? undefined
		: entries.find((entry) => sameModel(entry.model, sticky));
	if (stickyEntry && usability(stickyEntry.model) === "usable") return stickyEntry;
	const first = entries.find((entry) => usability(entry.model) === "usable");
	if (first) return first;
	const reasons = entries.map((entry) => `${modelIdentity(entry.model)} (${
		usability(entry.model) === "excluded" ? "excluded by model policy" : "unavailable"
	})`);
	throw new Error(
		`Virtual model ${VIRTUAL_MODEL_PROVIDER}/${name} has no usable entry: ${reasons.join(", ")}`,
	);
}

/** The policy file shape `parseVirtualModels` reads back. */
export function serializeVirtualModels(
	definitions: VirtualModelDefinitions,
): Record<string, Array<{ id: string; thinking: RuntimeThinkingLevel }>> {
	return Object.fromEntries(Object.entries(definitions).map(([name, entries]) => [
		name,
		entries.map((entry) => ({ id: modelIdentity(entry.model), thinking: entry.thinking })),
	]));
}

function parseEntries(name: string, value: unknown): readonly VirtualModelEntry[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`Workflow Policy virtual model ${name} must be a nonempty sequence of entries`);
	}
	const entries = value.map((entry): VirtualModelEntry => {
		if (
			typeof entry !== "object" || entry === null || Array.isArray(entry) ||
			Object.keys(entry).some((key) => key !== "id" && key !== "thinking") ||
			!("id" in entry) || !("thinking" in entry)
		) {
			throw new Error(ENTRY_RULE);
		}
		const model = parseRealModelReference(entry.id);
		if (!isRuntimeThinkingLevel(entry.thinking)) {
			throw new Error(`Workflow Policy virtual model ${name} has an invalid thinking level`);
		}
		return Object.freeze({ model, thinking: entry.thinking });
	});
	const identities = entries.map((entry) => modelIdentity(entry.model));
	if (new Set(identities).size !== identities.length) {
		throw new Error(`Workflow Policy virtual model ${name} contains a duplicate id`);
	}
	return Object.freeze(entries);
}

function parseRealModelReference(value: unknown): ModelReference {
	if (typeof value !== "string") throw new Error(ENTRY_RULE);
	// A model id may itself contain slashes, so only the first separator is structural.
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) throw new Error(ENTRY_RULE);
	const model = { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
	// Pi refuses to route a virtual model to another virtual model.
	if (isVirtualModel(model)) throw new Error(ENTRY_RULE);
	return Object.freeze(model);
}

function sameModel(left: ModelReference, right: ModelReference): boolean {
	return left.provider === right.provider && left.modelId === right.modelId;
}
