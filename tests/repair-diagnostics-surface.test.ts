import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { openRepairDiagnostics } from "../src/presentation/repair-diagnostics-surface.ts";
import type { RepairLaunch } from "../src/repair/repair-launch.ts";

test("repair inspection selects read-only Owner, Moderator and audit evidence without terminal escape execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "repair-inspection-"));
	const storageRoot = join(directory, "storage");
	const attemptId = "attempt";
	await mkdir(join(storageRoot, attemptId, "snapshot"), { recursive: true });
	await mkdir(join(storageRoot, attemptId, "seals", "seal"), { recursive: true });
	await writeFile(join(directory, "events.jsonl"), "Progress\x1b]52;c;attack\x07\x1b[2J");
	const ownerPath = join(storageRoot, attemptId, "snapshot", "file-0");
	await writeFile(ownerPath, "Immutable Owner transcript");
	await writeFile(join(directory, "moderator.jsonl"), "Repair-only Moderator transcript");
	await writeFile(join(storageRoot, attemptId, "seals", "seal", "report.txt"), "Protocol-effect audit");
	const launch: RepairLaunch = { version: 1, attemptId, moderatorAgentId: "moderator", storageRoot,
		owner: { path: "/original/owner.jsonl", workflowId: "owner", sessionId: "owner", identityEntryId: "identity" },
		participantDirectory: "/participants", cwd: directory, agentDir: directory,
		model: { provider: "fixture", modelId: "fixture" }, thinking: "off", creationPreset: null };
	let component!: Component;
	let ready!: () => void;
	const created = new Promise<void>((resolve) => { ready = resolve; });
	const terminal = { rows: 12 };
	const ui = { custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component) {
		return new Promise<T>((resolve) => {
			component = factory({ terminal, requestRender() {} } as unknown as TUI,
				{ fg: (_color: string, text: string) => text } as Theme, {} as KeybindingsManager, resolve);
			ready();
		});
	} } as unknown as ExtensionUIContext;
	const inspected = openRepairDiagnostics(ui, launch, directory);
	await created;
	assert.match(component.render(120).join("\n"), /Progress/);
	assert.doesNotMatch(component.render(120).join("\n"), /attack|\x1b\]/);
	for (const [key, text] of [["2", "Immutable Owner transcript"], ["3", "Repair-only Moderator transcript"], ["4", "Protocol-effect audit"]]) {
		component.handleInput?.(key);
		assert.match(component.render(120).join("\n"), new RegExp(text));
	}
	for (const [columns, rows] of [[100, 20], [12, 3], [1, 1], [100, 20]]) {
		terminal.rows = rows;
		const lines = component.render(columns);
		assert.equal(lines.length, rows);
		assert.ok(lines.every((line) => visibleWidth(line) <= columns));
	}
	component.handleInput?.("q");
	await inspected;
	assert.equal(await readFile(ownerPath, "utf8"), "Immutable Owner transcript");
});
