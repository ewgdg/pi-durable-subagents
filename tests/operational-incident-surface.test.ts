import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { OperationalIncidentSurface } from "../src/presentation/operational-incident-surface.ts";

test("exhausted handling remains a passive attention source without a duplicate widget", () => {
	const surface = new OperationalIncidentSurface();
	const attention = {
		trigger: {
			kind: "dependency_deadlock" as const,
			agentIds: ["agent-alpha", "agent-bravo"],
			requests: {
				total: 2,
				sources: [
					{ agentId: "agent-alpha", entryId: "request-a", toolCallId: "call-a" },
					{ agentId: "agent-bravo", entryId: "request-b", toolCallId: "call-b" },
				],
			},
		},
		affectedAgents: [
			{ agentId: "agent-alpha", label: "Alpha" },
			{ agentId: "agent-bravo", label: "Bravo" },
		],
		diagnostics: [
			{ agentId: "moderator-first", entryId: "terminal-first" },
			{ agentId: "moderator-second", entryId: "terminal-second" },
		],
	};

	surface.present("condition-key", attention);
	assert.deepEqual(surface.items(), [attention]);

	surface.dismiss("condition-key");
	assert.deepEqual(surface.items(), []);
});
