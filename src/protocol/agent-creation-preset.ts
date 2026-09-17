import { Type } from "typebox";
import { Check } from "typebox/value";

import type { AgentCreationPreset } from "../templates/agent-templates.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { RUNTIME_THINKING_LEVELS } from "./runtime-configuration.ts";

const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });
const Selection = Type.Array(Identifier, { uniqueItems: true });
const CreationPresetSchema = Type.Union([
	Type.Null(),
	Type.Object({
		models: Type.Optional(Type.Array(Type.Object({
			model: Type.Object({ provider: Identifier, modelId: Identifier }, { additionalProperties: false }),
			thinking: Type.Union(RUNTIME_THINKING_LEVELS.map((level) => Type.Literal(level))),
		}, { additionalProperties: false }), { minItems: 1, uniqueItems: true })),
		excludeTools: Type.Optional(Selection),
		excludeSkills: Type.Optional(Selection),
		extensions: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("none")])),
		systemPromptMode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		loadContextFiles: Type.Boolean(),
		systemPrompt: Type.String(),
	}, { additionalProperties: false }),
]);

export function isAgentCreationPreset(value: unknown): value is AgentCreationPreset {
	return Check(CreationPresetSchema, value);
}

export function validateAgentCreationPreset(value: unknown): AgentCreationPreset {
	if (!isAgentCreationPreset(value)) {
		throw new ProtocolInvariantError("Agent creation preset has an invalid shape");
	}
	return structuredClone(value);
}
