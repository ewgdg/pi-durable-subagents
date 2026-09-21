import assert from "node:assert/strict";
import test from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import { agentControlMethods } from "../src/control/agent-control-protocol.ts";
import { AgentTemplateCatalogueEntrySchema } from "../src/control/control-protocol-schemas.ts";
import { isRuntimeThinkingLevel, RUNTIME_THINKING_LEVELS } from "../src/protocol/runtime-configuration.ts";
import { RuntimeThinkingSchema } from "../src/protocol/runtime-thinking-schema.ts";
import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";
import { participantCoordinationToolSchemas } from "../src/tools/participant-coordination-tools.ts";

type AssertNever<T extends never> = T;
type SchemaMissingLevels = AssertNever<Exclude<ThinkingLevel, Static<typeof RuntimeThinkingSchema>>>;
type SchemaInvalidLevels = AssertNever<Exclude<Static<typeof RuntimeThinkingSchema>, ThinkingLevel>>;

test("thinking validators and schemas accept every Pi level, with inherit only at spawn input", () => {
	for (const thinking of [...RUNTIME_THINKING_LEVELS, "inherit", "invalid", "", null, 1]) {
		const runtimeLevel = RUNTIME_THINKING_LEVELS.some((level) => level === thinking);
		const spawnLevel = runtimeLevel || thinking === "inherit";
		assert.equal(isRuntimeThinkingLevel(thinking), runtimeLevel);
		assert.equal(Check(RuntimeThinkingSchema, thinking), runtimeLevel);
		// One atomic selection, so the schema judges the level rather than the pairing.
		const input = {
			title: "Fixture request",
			request: "Work",
			config: { model: { id: "provider/model", thinking } },
		};
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, input), spawnLevel);
		if (spawnLevel) {
			assert.deepEqual(validateAgentSpawnInput(input), input);
		} else {
			assert.throws(() => validateAgentSpawnInput(input));
		}
		assert.equal(Check(AgentTemplateCatalogueEntrySchema, {
			name: "worker",
			models: [{ model: { provider: "provider", modelId: "model" }, thinking }],
			systemPromptMode: "append",
			loadContextFiles: true,
		}), runtimeLevel);
		assert.equal(Check(agentControlMethods["coordination.spawn"].response, {
			spawnStatus: "created",
			agentId: "child",
			requestMessageId: "creation-request",
			messageStatus: "sent",
			effectiveConfiguration: {
				cwd: "/project",
				model: { provider: "provider", modelId: "model" },
				thinking,
				excludeTools: [],
				excludeSkills: [],
				skills: [],
				extensions: [],
				loadContextFiles: true,
			},
		}), runtimeLevel);
	}
});
