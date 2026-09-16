import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as pty from "node-pty";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { resolveInstalledPiCliPath } from "../src/process-runtime/pi-child-process-runtime.ts";
import { createRepairModelServer } from "./support/repair-model-server.ts";

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const end = Date.now() + 15_000;
	while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(25); }
}

for (const scenario of ["healthy", "rejected-only", "config-error", "duplicate", "preserve-rejected", "repeat", "bash", "cleanup-reject", "parking-cancel", "admission-fail", "cancel", "command-cancel", "helper-kill", "idle-human", "live-navigation"] as const) {
test(`real same-terminal admission repair: ${scenario}`, { timeout: 30_000, skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-cli-"));
	const agentDir = join(root, "agent");
	await mkdir(join(agentDir, "config"), { recursive: true });
	const server = await createRepairModelServer();
	const noRepair = scenario === "healthy" || scenario === "rejected-only" || scenario === "config-error";
	let repairRequests = 0;
	let ordinaryRequests = 0;
	let releaseModel: (() => void) | undefined;
	server.setResponses((request) => {
		if (!request.tools.some((tool) => JSON.stringify(tool).includes("repair_snapshot"))) { ordinaryRequests++; return "Ordinary conversation remains usable."; }
		repairRequests++;
		assert.deepEqual(request.tools.map((tool) => (tool as { function: { name: string } }).function.name).sort(), ["repair_candidate", "repair_report", "repair_snapshot"]);
		if (scenario === "cancel" || scenario === "command-cancel" || scenario === "helper-kill") return new Promise<string>((resolve) => { releaseModel = () => resolve("Cancelled."); });
		if (scenario === "live-navigation" && repairRequests === 1) return new Promise((resolve) => {
			releaseModel = () => resolve({ name: "repair_snapshot", arguments: { id: "file-0" } });
		});
		if (scenario === "live-navigation" && repairRequests === 3) return new Promise((resolve) => {
			releaseModel = () => resolve({ name: "repair_report", arguments: { kind: "complete", text: "Only exact redundant Delivery removed." } });
		});
		if (repairRequests === 1) return { name: "repair_snapshot", arguments: { id: "file-0" } };
		if (repairRequests === 2) {
			const original = request.messages.findLast((message) => (message as { role: string }).role === "tool") as { content: string };
			const entries = original.content.trim().split("\n").map((line) => JSON.parse(line));
			const deliveries = entries.filter((entry) => entry.customType === "agent-coordination.message-delivery");
			assert.equal(deliveries.length, 2);
			const duplicate = deliveries[1];
			// The scripted transport proposes only the lossless duplicate removal.
			// It is independent of the production certificate/validator.
			const candidate = entries.filter((entry) => entry.id !== duplicate.id).map((entry) =>
				entry.parentId === duplicate.id ? { ...entry, parentId: duplicate.parentId } : entry);
			return { name: "repair_candidate", arguments: { id: "file-0", contents: candidate.map((entry) => JSON.stringify(entry)).join("\n") + "\n" } };
		}
		if (repairRequests === 3) return { name: "repair_report", arguments: { kind: "complete", text: "Removed only the exact redundant Delivery envelope; kept original evidence and rejected history." } };
		return "Proposal complete.";
	});
	const modelsConfiguration = structuredClone(server.modelsConfiguration);
	if (scenario === "idle-human") Object.assign(modelsConfiguration.providers[server.provider].models[0], { reasoning: true });
	await writeFile(join(agentDir, "models.json"), JSON.stringify(modelsConfiguration));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, quietStartup: true, compaction: { enabled: false } }));
	if (scenario === "config-error") await writeFile(join(agentDir, "config", "pi-agent-coordination.json"), '{"maxConcurrentAgentRuns":0}');
	const ownerPath = join(root, "owner.jsonl");
	const ownerId = randomUUID();
	const owner = SessionManager.inMemory(root, { id: ownerId });
	owner.appendCustomEntry("agent-coordination.identity", { agentId: ownerId, workflowId: ownerId, directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
	let rejectedEntry: unknown;
	let rejectedRequestId: string | undefined;
	if (scenario === "rejected-only" || scenario === "preserve-rejected") {
		const id = owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", targetAgent: ownerId, question: "Obsolete request superseded by later work" }, { id: "old-rejected-request" })));
		rejectedRequestId = deriveMessageIdentity({ agentId: ownerId, entryId: id, toolCallId: "old-rejected-request" });
		owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "old-rejected-request", content: [], isError: false, timestamp: Date.now(), details: { requestMessageId: rejectedRequestId, targetAgentId: ownerId, messageStatus: "sent" } });
		rejectedEntry = owner.getEntries().find((entry) => entry.id === id);
	}
	owner.appendMessage(fauxAssistantMessage("Later work is complete. Do not resurrect the obsolete request."));
	let childPath: string | undefined;
	let childContents: string | undefined;
	if (!noRepair) {
		const childId = randomUUID();
		const spawnEntry = scenario === "idle-human" ? "unused" : owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Existing reader", request: "Read the synthetic note only.", label: "Reader" }, { id: "existing-spawn" })));
		const child = SessionManager.inMemory(root, { id: childId });
		child.appendCustomEntry("agent-coordination.identity", { agentId: childId, workflowId: ownerId, directSpawnerAgentId: ownerId, creationPreset: null,
			spawnSource: { agentId: ownerId, entryId: spawnEntry, toolCallId: "existing-spawn" }, metadata: { label: "Reader" } });
		child.appendModelChange(server.provider, server.modelId);
		child.appendThinkingLevelChange("off");
		const participants = join(root, "pi-agent-coordination", Buffer.from(ownerId).toString("base64url"));
		await mkdir(participants, { recursive: true });
		childPath = join(participants, "reader.jsonl");
		const callId = "duplicate-delivery-source";
		const author = scenario === "live-navigation" ? child : owner;
		const entryId = author.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", targetAgent: ownerId, title: "Read garden note", question: "Summarize the synthetic garden note." }, { id: callId })));
		const source = { agentId: author.getSessionId(), entryId, toolCallId: callId };
		const requestMessageId = deriveMessageIdentity(source);
		author.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: callId, content: [], isError: false, timestamp: Date.now(), details: { requestMessageId, targetAgentId: ownerId, messageStatus: "sent" } });
		const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId, fromAgentId: source.agentId, title: "Read garden note", question: "Summarize the synthetic garden note." } }]);
		for (let copy = 0; copy < 2; copy++) owner.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
		if (scenario !== "idle-human") owner.appendMessage(fauxAssistantMessage("The duplicate is earlier than this unchanged native leaf."));
		else owner.appendMessage({ role: "user", content: [{ type: "text", text: "Saved user marker after the duplicate. Do not start until I send a new message." }], timestamp: Date.now() });
		childContents = [child.getHeader(), ...child.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
		if (scenario !== "idle-human") await writeFile(childPath, childContents);
	}
	await writeFile(ownerPath, [owner.getHeader(), ...owner.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const fixturePath = join(root, "lifecycle-observation.mjs");
	await writeFile(fixturePath, `import {writeFileSync} from 'node:fs';
		import * as hostPi from '@earendil-works/pi-coding-agent';
		import {installInteractiveHostBridge} from ${JSON.stringify(resolve("src/pi-integration/interactive-host-bridge.ts"))};
		export default function(pi) {
			let runtime, clearFailure;
			pi.on('session_start', async (_event, ctx) => {
				runtime = (await installInteractiveHostBridge(hostPi).capture(ctx.sessionManager,ctx.ui)).runtime;
				const host = ctx.sessionManager.getEntries().some(entry => entry.customType === 'agent-coordination.repair-host');
				if (!host && !globalThis.__repairOriginalManager) globalThis.__repairOriginalManager = ctx.sessionManager;
				if (${JSON.stringify(scenario)} === 'admission-fail' && host) writeFileSync(${JSON.stringify(join(agentDir, "config", "pi-agent-coordination.json"))}, '{"maxConcurrentAgentRuns":0}');
				if (${JSON.stringify(scenario)} === 'cleanup-reject' && !host) {
					const abort = runtime.session.abort.bind(runtime.session);
					runtime.session.abort = async () => { await abort(); throw new Error('actual native cleanup dependency rejected'); };
					clearFailure = () => {runtime.session.abort = abort;};
				}
				writeFileSync(${JSON.stringify(join(root, "ready.json"))}, JSON.stringify({pid:process.pid,path:ctx.sessionManager.getSessionFile(),tools:pi.getActiveTools()}));
			});
			pi.on('session_before_switch', event => ${JSON.stringify(scenario)} === 'parking-cancel' && event.targetSessionFile?.endsWith('repair-host.jsonl') ? {cancel:true} : undefined);
			pi.on('session_shutdown', () => { if (${JSON.stringify(scenario)} !== 'idle-human') pi.appendEntry('repair-test-final-write', {pid:process.pid}); });
			pi.registerCommand('repair-test-bash', {handler:async () => { void runtime.session.executeBash('echo BASH_STARTED; sleep 30', chunk => {if(chunk.includes('BASH_STARTED'))writeFileSync(${JSON.stringify(join(root,"bash-started"))},'started');}); }});
			pi.registerCommand('repair-test-clear-failure', {handler:() => clearFailure?.()});
			pi.registerCommand('repair-test-native-change', {handler:() => runtime.session.setThinkingLevel('high')});
			pi.registerCommand('repair-test-unsafe-open', {handler:async (_args,ctx) => writeFileSync(${JSON.stringify(join(root,"unsafe-open.json"))}, JSON.stringify(await ctx.switchSession(${JSON.stringify(ownerPath)})))});
			pi.registerCommand('repair-test-ping', {handler:(_args,ctx) => writeFileSync(${JSON.stringify(join(root, "ping.json"))}, JSON.stringify({pid:process.pid,path:ctx.sessionManager.getSessionFile(),nativeManagerReplaced:ctx.sessionManager !== globalThis.__repairOriginalManager,tools:pi.getActiveTools()}))});
		}`);
	const terminal = pty.spawn(process.execPath, [resolveInstalledPiCliPath(), "--session", ownerPath,
		"--no-extensions", "--extension", process.env.REPAIR_TEST_EXTENSION ?? resolve("src/index.ts"), "--extension", fixturePath,
		"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
		"--model", `${server.provider}/${server.modelId}`, "--thinking", "off"],
		{ cwd: root, cols: 100, rows: 35, name: "xterm-256color", env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" } });
	terminal.onData((chunk) => appendFileSync(join(root, "terminal.log"), chunk));
	const exited = new Promise<void>((done) => terminal.onExit(() => done()));
	const repairRoot = join(root, "pi-agent-coordination-repair", Buffer.from(ownerId).toString("base64url"));
	try {
		await until(() => existsSync(join(root, "ready.json")), `Owner startup (${root})`);
		const initial = JSON.parse(await readFile(join(root, "ready.json"), "utf8"));
		assert.equal(initial.tools.includes("agent_message"), scenario === "healthy" || scenario === "rejected-only");
		if (!noRepair) await until(async () => (await readFile(join(root,"terminal.log"),"utf8")).includes("Subagent coordination blocked"), "actual admission blockage widget");
		const beforeCommand = await readFile(ownerPath, "utf8");
		if (scenario === "bash") { terminal.write("/repair-test-bash\r"); await until(() => existsSync(join(root,"bash-started")), "native bash"); }
		terminal.write("/agents repair\r");
		if (noRepair) {
			const message = scenario === "config-error" ? "no actual transcript admission" : "No repair needed";
			await until(async () => (await readFile(join(root,"terminal.log"),"utf8")).includes(message), "preflight refusal");
			assert.equal(existsSync(repairRoot), false);
			assert.equal(await readFile(ownerPath, "utf8"), beforeCommand);
			assert.equal(repairRequests, 0);
			terminal.write("/repair-test-ping\r");
			await until(() => existsSync(join(root,"ping.json")), "input remains usable");
			assert.equal(JSON.parse(await readFile(join(root,"ping.json"),"utf8")).nativeManagerReplaced, false);
			return;
		}
		if (scenario === "cancel" || scenario === "command-cancel") { await until(() => repairRequests > 0, "model started"); terminal.write(scenario === "cancel" ? "\u001b" : "/agents repair cancel\r"); }
		if (scenario === "live-navigation") {
			await until(() => repairRequests === 1, "held helper before completed tool output");
			terminal.write("/repair-test-ping\r");
			await delay(500);
			assert.ok(existsSync(join(root, "ping.json")), "repair must leave native slash commands responsive while helper is held");
			terminal.write("/repair-test-unsafe-open\r");
			await until(() => existsSync(join(root, "unsafe-open.json")), "native reopening attempt refused while uncommitted");
			assert.equal(JSON.parse(await readFile(join(root, "unsafe-open.json"), "utf8")).cancelled, true);
			terminal.write("/agents\r");
			await delay(250);
			assert.ok((await readFile(join(root, "terminal.log"), "utf8")).includes("Repair Moderator"), "repair-only Moderator must be navigable during repair");
			terminal.write("\r");
			await until(async () => (await readFile(join(root, "terminal.log"), "utf8")).includes("Persisted Moderator transcript"), "actual repair Moderator view");
			releaseModel?.();
			await until(() => repairRequests === 3, "later candidate tool completed while viewer stays open");
			await delay(100);
			terminal.write("\u001b[F");
			await until(async () => (await readFile(join(root, "terminal.log"), "utf8")).includes("Candidate copy written"), "already-open view refreshes actual completed tool result");
			terminal.write("2");
			await delay(100);
			assert.equal(ordinaryRequests, 0, "Owner snapshot navigation starts no turn");
			// Complete while the read-only overlay is open: reopening must close it.
			releaseModel?.();
		}
		if (scenario === "helper-kill") {
			await until(() => repairRequests > 0, "model started");
			const [attempt] = await readdir(join(repairRoot,"hosts"));
			const helper = JSON.parse(await readFile(join(repairRoot,"hosts",attempt,"helper.json"),"utf8"));
			process.kill(helper.pid,"SIGKILL");
		}
		let id = "";
		await until(async () => {
			if (!existsSync(join(repairRoot,"hosts"))) return false;
			[id] = await readdir(join(repairRoot,"hosts"));
			return !!id && existsSync(join(repairRoot,"hosts",id,"outcome.json"));
		}, `repair outcome (${root})`);
		const directory = join(repairRoot,"hosts",id);
		const refused = ["cleanup-reject","parking-cancel","cancel","command-cancel","helper-kill"].includes(scenario);
		const outcome = JSON.parse(await readFile(join(directory,"outcome.json"),"utf8"));
		if (refused) {
			assert.equal(outcome.outcome,"refused");
			assert.equal(existsSync(join(repairRoot,"storage",id,"committed.json")),false);
			if (scenario === "cleanup-reject" || scenario === "parking-cancel") assert.equal(existsSync(join(repairRoot,"storage",id,"manifest.json")),false);
			await delay(250);
			if (scenario === "cleanup-reject") {
				terminal.write("/repair-test-clear-failure\r"); await delay(50);
				terminal.write("/agents repair park\r");
				await until(async () => JSON.parse(await readFile(join(root,"ready.json"),"utf8")).path.endsWith("repair-host.jsonl"),"park refused Owner");
				await delay(250);
				terminal.write("/agents repair recover\r");
				await until(async () => (await readFile(join(root,"terminal.log"),"utf8")).includes("no verified retirement handoff"),"missing ACK refusal");
				assert.equal(existsSync(join(directory,"admission.jsonl")),false);
			}
			if (scenario === "cancel" || scenario === "command-cancel" || scenario === "helper-kill" || scenario === "cleanup-reject") {
				terminal.write(scenario === "cancel" || scenario === "command-cancel" ? "/agents repair recover\r" : "/agents repair recover-stopped\r");
				await until(() => existsSync(join(directory,"admission.jsonl")),"recovery attempts real admission");
				// Restoring original blocked evidence is safe disk recovery, not successful admission.
				assert.equal(JSON.parse((await readFile(join(directory,"admission.jsonl"),"utf8")).trim()).admitted,false);
			}
			return;
		}
		assert.equal(outcome.outcome, scenario === "admission-fail" ? "committed_admission_failed" : "admitted", root);
		assert.ok(existsSync(join(repairRoot,"storage",id,"committed.json")));
		const snapshot = await readFile(join(repairRoot,"storage",id,"snapshot","file-0"),"utf8");
		if (scenario !== "idle-human") assert.match(snapshot,/repair-test-final-write/);
		assert.equal(snapshot.split('"customType":"agent-coordination.message-delivery"').length-1,2);
		const repaired = await readFile(ownerPath,"utf8");
		assert.equal(repaired.split('"customType":"agent-coordination.message-delivery"').length-1,1);
		if (scenario !== "idle-human") {
			assert.equal(await readFile(childPath!, "utf8"), childContents, "dormant child must remain unchanged");
			assert.equal(await readFile(join(repairRoot, "storage", id, "snapshot", "file-1"), "utf8"), childContents);
		}
		if (scenario === "bash") assert.match(snapshot,/"cancelled":true/);
		if (rejectedEntry) {
			assert.deepEqual(repaired.trim().split("\n").map(line=>JSON.parse(line)).find(entry=>entry.id===(rejectedEntry as {id:string}).id),rejectedEntry);
			const [sealId] = await readdir(join(repairRoot,"storage",id,"seals"));
			const report = JSON.parse(await readFile(join(repairRoot,"storage",id,"seals",sealId,"report.txt"),"utf8"));
			assert.equal(report.valid,true);
			assert.equal(report.protocolEffects.changes.some((change: {category:string;after?:{messageId:string}})=>change.category==="pending_delivery" && change.after?.messageId===rejectedRequestId),false);
		}
		const bootstrap = JSON.parse(await readFile(join(directory,"moderator-bootstrap.json"),"utf8"));
		assert.equal(bootstrap.workflowId,ownerId);
		assert.equal(bootstrap.directSpawnerAgentId,null);
		assert.notEqual(bootstrap.agentId,ownerId);
		await delay(250);
		terminal.write("/repair-test-ping\r");
		await until(async ()=>existsSync(join(root,"ping.json")) && JSON.parse(await readFile(join(root,"ping.json"), "utf8")).path === ownerPath,"same terminal after repair");
		const ping = JSON.parse(await readFile(join(root,"ping.json"),"utf8"));
		assert.equal(ping.pid,terminal.pid);
		assert.equal(ping.path,ownerPath);
		assert.equal(ping.nativeManagerReplaced,true);
		assert.equal(ping.tools.includes("agent_message"),scenario!=="admission-fail");
		assert.equal(ordinaryRequests,0,"repair must not automatically resume participants");
		assert.equal(repairRequests,4);
		if (scenario === "live-navigation") {
			assert.equal((await readFile(join(root, "terminal.log"), "utf8")).includes("startup_admission_cancelled"), false, "successful repair handoff is command completion, not cancelled model preflight");
			const previousOutput = (await readFile(join(root, "terminal.log"), "utf8")).length;
			terminal.write("/agents\r");
			await delay(200);
			assert.ok((await readFile(join(root, "terminal.log"), "utf8")).slice(previousOutput).includes("Repair Moderator"), "retained repair Moderator remains in normal /agents navigation");
			terminal.write("\r");
			await until(async () => (await readFile(join(root, "terminal.log"), "utf8")).slice(previousOutput).includes("Persisted Moderator transcript"), "retained Moderator selection opens actual transcript");
			terminal.write("q");
			await delay(100);
			terminal.write("\u001b");
			assert.equal(ordinaryRequests, 0, "selecting and closing Moderator cannot start Owner work");
		}
		if (scenario === "idle-human") {
			const originalUsers = repaired.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message" && entry.message.role === "user");
			terminal.write("/agents repair inspect\r");
			await delay(100);
			terminal.write("q");
			terminal.write("/repair-test-native-change\r");
			await delay(2000);
			assert.equal(ordinaryRequests, 0, "repaired Owner must not auto-continue its unanswered Request");
			const heldEntries = (await readFile(ownerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			assert.deepEqual(heldEntries.filter(entry => entry.type === "message" && entry.message.role === "user"), originalUsers, "no synthetic empty user message may be appended while held");
			assert.equal(heldEntries.some(entry => entry.customType === "agent-coordination.obligation-reminder"), false);
			terminal.write("Please continue now.\r");
			await until(() => ordinaryRequests === 1, "new human prompt starts Owner exactly once");
		}
		if (scenario === "repeat") {
			terminal.write("/agents repair\r");
			await until(async ()=>(await readFile(join(root,"terminal.log"),"utf8")).includes("No repair needed"),"successful admission no longer authorizes no-op repair");
			assert.deepEqual(await readdir(join(repairRoot,"hosts")),[id]);
			assert.equal(repairRequests,4);
			terminal.write("/agents repair inspect\r");
			await until(async ()=>(await readFile(join(root,"terminal.log"),"utf8")).includes("Validation audit"),"historical diagnostics remain available");
			terminal.write("q");
		}
	} finally { releaseModel?.(); terminal.kill(); await exited; await server.close(); }
});
}
