import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	formatSelectedAgentIdentity,
	selectedAgentWorkStatus,
} from "../src/presentation/selected-agent-status.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;

const identity = {
	label: "Researcher",
	agentId: "019fa1ff-6e95-761e-b4ce-7415983c81e3",
};

test("quota suspension stays visible despite pending work or compaction", () => {
	const evidence = { diagnostic: "Codex error: The usage limit has been reached", provider: "openai-codex", model: "gpt-5" };
	const status = selectedAgentWorkStatus({
		phase: "live", work: "active", attention: "none", retentionReasons: [],
		suspension: { reason: "provider_quota", evidence },
	}, false, true);
	assert.deepEqual(status, { kind: "suspended", evidence });
	assert.match(formatSelectedAgentIdentity({ ...identity, status }, theme), /<warning>Suspended · Usage limit reached<\/warning>/);
});

test("selected Agent identity gives every work status its specified theme role", () => {
	const cases = [
		{ status: { kind: "active" as const }, role: "success", label: "active" },
		{ status: { kind: "dormant" as const }, role: "dim", label: "dormant" },
		{ status: { kind: "idle" as const }, role: "dim", label: "idle" },
		{
			status: { kind: "waiting" as const, reason: "human input" },
			role: "warning",
			label: "waiting (human input)",
		},
		{ status: { kind: "starting" as const }, role: "accent", label: "starting" },
		{ status: { kind: "ending" as const }, role: "dim", label: "ending" },
		{ status: { kind: "failed" as const }, role: "error", label: "failed" },
	] as const;

	for (const { status, role, label } of cases) {
		assert.equal(
			formatSelectedAgentIdentity({ ...identity, status }, theme),
			`<accent><bold>Researcher</bold></accent><dim> · 983c81e3 · </dim><${role}>${label}</${role}>`,
		);
	}
});

test("selected status distinguishes external waits from active and settled work", () => {
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "active",
			attention: "none",
			retentionReasons: [],
		}, false),
		{ kind: "active" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		}, false),
		{ kind: "idle" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "active",
			attention: "input_required",
			retentionReasons: [],
		}, false),
		{ kind: "waiting", reason: "human input" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [{ reason: "awaiting_answer", count: 1 }],
		}, false),
		{ kind: "waiting", reason: "agent answer" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [{ reason: "interruption_hold", count: 1 }],
		}, false),
		{ kind: "waiting", reason: "resumption" },
	);
});

test("selected lifecycle transitions and failure take precedence", () => {
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "starting",
			attention: "none",
			retentionReasons: [],
		}, false),
		{ kind: "starting" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "ending",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		}, false),
		{ kind: "ending" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "dormant",
			retentionReasons: [],
		}, false),
		{ kind: "dormant" },
	);
	assert.deepEqual(
		selectedAgentWorkStatus({
			phase: "live",
			work: "active",
			attention: "none",
			retentionReasons: [],
		}, true),
		{ kind: "failed" },
	);
});

test("compaction overlays ordinary work without changing the underlying status", () => {
 for (const work of ["active", "settled"] as const) {
  const run = { phase: "live", work, attention: "none", retentionReasons: [] } as const;
  assert.deepEqual(selectedAgentWorkStatus(run, false, true), { kind: "compacting" });
  assert.deepEqual(selectedAgentWorkStatus(run, false, false), { kind: work === "active" ? "active" : "idle" });
  assert.deepEqual(selectedAgentWorkStatus(run, true, true), { kind: "failed" });
 }
 assert.deepEqual(selectedAgentWorkStatus({ phase: "dormant", retentionReasons: [] }, false, true), { kind: "dormant" });
});
