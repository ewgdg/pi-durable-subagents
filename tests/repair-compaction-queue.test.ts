import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as pty from "node-pty";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { resolveInstalledPiCliPath } from "../src/process-runtime/pi-child-process-runtime.ts";
import { createRepairModelServer } from "./support/repair-model-server.ts";

test("native compaction-deferred steer and followup survive refusal without authorizing a stale repair proposal", { timeout: 20000, skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-compaction-queue-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const server = await createRepairModelServer();
	const requests: string[] = [];
	let freshComplete = false;
	server.setResponses(request => {
		const messages = JSON.stringify(request.messages);
		requests.push(messages);
		if (messages.includes("Fresh completion after queue drainage") && !freshComplete) {
			freshComplete = true;
			return { name: "test_complete", arguments: {} };
		}
		return "The native queued instruction was processed.";
	});
	await writeFile(join(agentDir, "models.json"), JSON.stringify(server.modelsConfiguration));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, compaction: { enabled: false, keepRecentTokens: 24, reserveTokens: 1000 } }));
	const manager = SessionManager.inMemory(root);
	for (let index = 0; index < 3; index++) {
		manager.appendMessage({ role: "user", content: "Context for compaction. ".repeat(200), timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("Prior answer."));
	}
	const sessionPath = join(root, "session.jsonl");
	await writeFile(sessionPath, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const fixturePath = join(root, "fixture.mjs");
	await writeFile(fixturePath, `
import {writeFileSync} from 'node:fs';
import {Type} from 'typebox';
import {ProposalSettlementGate} from ${JSON.stringify(resolve("src/repair/proposal-settlement.ts"))};
import {createRepairCompactionHandler} from ${JSON.stringify(resolve("src/repair/helper-entry.ts"))};
export default function(pi) {
 const gate=new ProposalSettlementGate(); gate.reportComplete();
 let release, applications=0, settlements=0;
 const barrier=new Promise(resolve=>{release=resolve});
 const guard=createRepairCompactionHandler(gate,()=>false);
 pi.registerCommand('release-compaction',{handler:async()=>release()});
 pi.registerTool({name:'test_complete',label:'Complete',description:'Explicit fresh completion',parameters:Type.Object({}),
  async execute(){gate.reportComplete();return {content:[{type:'text',text:'Complete recorded'}],details:{}}}});
 pi.on('session_start',()=>{writeFileSync(${JSON.stringify(join(root, "ready"))},'ready')});
 pi.on('session_before_compact',async(event,ctx)=>{
  writeFileSync(${JSON.stringify(join(root, "compacting"))},'compacting');
  await barrier; return guard(event,ctx);
 });
 pi.on('agent_settled',(_event,ctx)=>{
  const authorization=gate.freezeOnSettlement({generation:gate.generation,outcome:'completed',hasPendingMessages:ctx.hasPendingMessages()});
  if(authorization && gate.beginApplication(authorization)) applications++;
  writeFileSync(${JSON.stringify(join(root, "settled.json"))},JSON.stringify({applications,settlements:++settlements}));
 });
}`);
	const terminal = pty.spawn(process.execPath, [resolveInstalledPiCliPath(), "--session", sessionPath,
		"--extension", fixturePath, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
		"--model", `${server.provider}/${server.modelId}`, "--thinking", "off"],
	{ cwd: root, cols: 100, rows: 35, name: "xterm-256color", env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" } });
	let output = "";
	terminal.onData(data => { output += data; });
	const exited = new Promise<void>(resolve => terminal.onExit(() => resolve()));
	async function until(predicate: () => boolean | Promise<boolean>, label: string) {
		const end = Date.now() + 10000;
		while (!await predicate()) { assert.ok(Date.now() < end, `${label}: ${root}`); await delay(10); }
	}
	try {
		await until(() => existsSync(join(root, "ready")), "native startup");
		terminal.write("/compact\r");
		await until(() => existsSync(join(root, "compacting")), "native compaction barrier");
		terminal.write("Compaction deferred followup\x1b\r");
		await until(() => output.includes("Queued message for after compaction"), "native followup queued");
		terminal.write("Compaction deferred steer\r");
		await until(() => output.includes("Compaction deferred steer"), "native steer queued");
		terminal.write("/release-compaction\r");
		await until(() => existsSync(join(root, "settled.json")) && requests.some(value => value.includes("Compaction deferred followup") && value.includes("Compaction deferred steer")), "both native deferred messages processed");
		assert.equal(JSON.parse(await readFile(join(root, "settled.json"), "utf8")).applications, 0);
		assert.match(output, /Compaction is unavailable until repair commits/);
		terminal.write("Fresh completion after queue drainage\r");
		await until(async () => JSON.parse(await readFile(join(root, "settled.json"), "utf8")).applications === 1, "fresh complete applies once");
	} finally { terminal.kill(); await exited; await server.close(); }
});
