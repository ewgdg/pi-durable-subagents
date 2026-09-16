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
import { resolveInstalledPiCliPath } from "../src/process-runtime/pi-child-process-runtime.ts";
import { createRepairModelServer } from "./support/repair-model-server.ts";

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const end = Date.now() + 15_000;
	while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(25); }
}

for (const scenario of ["clean", "repeat", "managed-child", "repair-edit", "bash", "cleanup-reject", "parking-cancel", "admission-fail", "initial-admission-fail", "cancel", "helper-kill"] as const) {
test(`real same-terminal repair: ${scenario}`, { timeout: 30_000, skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-cli-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const server = await createRepairModelServer();
	let repairRequests = 0;
	let ordinaryRequests = 0;
	let ordinaryRequestsBeforeRepair = 0;
	let releaseModel: (() => void) | undefined;
	server.setResponses((request) => {
		const repair = request.tools.some((tool) => JSON.stringify(tool).includes("repair_snapshot"));
		if (!repair) { ordinaryRequests++; return "Owner ready."; }
		repairRequests++;
		assert.deepEqual(request.tools.map((tool) => (tool as { function: { name: string } }).function.name).sort(), ["repair_candidate", "repair_report", "repair_snapshot"]);
		if ((scenario === "cancel" && repairRequests === 1) || scenario === "helper-kill") return new Promise<string>((resolve) => { releaseModel = () => resolve("Cancelled."); });
		if (scenario === "repair-edit") {
			if (repairRequests === 1) return { name: "repair_snapshot", arguments: { id: "file-0" } };
			if (repairRequests === 2) {
				const original = request.messages.findLast((message) => (message as { role: string }).role === "tool") as { content: string };
				assert.equal(typeof original.content, "string");
				assert.match(original.content, /"question":"Publish the release"/);
				return { name: "repair_candidate", arguments: { id: "file-0", contents: original.content.replace('"question":"Publish the release"', '"question":"Publish the release","title":"Publish release"') } };
			}
			if (repairRequests === 3) return { name: "repair_report", arguments: { kind: "complete", text: "Restored the missing title from the exact existing Request question; no accepted evidence changed." } };
			return "Proposal complete.";
		}
		return (scenario === "repeat" ? repairRequests % 2 === 1 : scenario === "cancel" ? repairRequests === 2 : repairRequests === 1)
			? { name: "repair_report", arguments: { kind: "complete", text: "Full original generation is already valid; preserve it." } }
			: "Proposal complete.";
	});
	await writeFile(join(agentDir, "models.json"), JSON.stringify(server.modelsConfiguration));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, quietStartup: true, compaction: { enabled: false } }));
	await mkdir(join(agentDir, "config"));
	if (scenario === "initial-admission-fail") await writeFile(join(agentDir, "config", "pi-agent-coordination.json"), '{"maxConcurrentAgentRuns":0}');
	const ownerPath = join(root, "owner.jsonl");
	const ownerId = randomUUID();
	const timestamp = new Date().toISOString();
	await writeFile(ownerPath, [
		{ type: "session", version: 3, id: ownerId, timestamp, cwd: root },
		{ type: "custom", id: "identity", parentId: null, timestamp, customType: "agent-coordination.identity", data: { agentId: ownerId, workflowId: ownerId, directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const fixturePath = join(root, "lifecycle-fixture.mjs");
	await writeFile(fixturePath, `import {writeFileSync, appendFileSync} from 'node:fs';
		import * as hostPi from '@earendil-works/pi-coding-agent';
		import {fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
		import {deriveMessageIdentity} from ${JSON.stringify(resolve("src/protocol/identities.ts"))};
		import {installInteractiveHostBridge} from ${JSON.stringify(resolve("src/pi-integration/interactive-host-bridge.ts"))};
		export default function(pi) {
			let runtime;
			let clearNativeFailure;
			pi.on('session_start', async (_event, ctx) => {
				runtime = (await installInteractiveHostBridge(hostPi).capture(ctx.sessionManager,ctx.ui)).runtime;
				const host = ctx.sessionManager.getEntries().some(entry => entry.customType === 'agent-coordination.repair-host');
				if (!host && !globalThis.__repairOriginalManager) globalThis.__repairOriginalManager = ctx.sessionManager;
				if (${JSON.stringify(scenario)} === 'admission-fail' && host) writeFileSync(${JSON.stringify(join(agentDir, "config", "pi-agent-coordination.json"))}, '{"maxConcurrentAgentRuns":0}');
				if (${JSON.stringify(scenario)} === 'cleanup-reject' && !host) {
					const abort = runtime.session.abort.bind(runtime.session);
					runtime.session.abort = async () => { await abort(); throw new Error('actual native cleanup dependency rejected'); };
					clearNativeFailure = () => { runtime.session.abort = abort; };
				}
				writeFileSync(${JSON.stringify(join(root, "ready.json"))}, JSON.stringify({pid:process.pid,path:ctx.sessionManager.getSessionFile(),id:ctx.sessionManager.getSessionId(),tools:pi.getActiveTools()}));
			});
			pi.on('session_before_switch', event => ${JSON.stringify(scenario)} === 'parking-cancel' && event.targetSessionFile?.endsWith('repair-host.jsonl') ? {cancel:true} : undefined);
			pi.on('session_shutdown', () => pi.appendEntry('repair-test-final-write', {pid:process.pid}));
			pi.on('agent_settled', () => { if(process.env.PI_AGENT_COORDINATION_BOOTSTRAP) appendFileSync(${JSON.stringify(join(root, "child-settled"))}, 'settled\\n'); });
			pi.registerCommand('repair-test-spawn', {handler:async () => {
				const input = {title:'Managed repair writer',request:'Remain available for repair retirement.'};
				runtime.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall('agent_spawn',input,{id:'repair-spawn'}),{stopReason:'toolUse'}));
				const result = await runtime.session.getToolDefinition('agent_spawn').execute('repair-spawn',input,undefined,undefined,runtime.session.extensionRunner.createContext());
				runtime.session.sessionManager.appendMessage({role:'toolResult',toolName:'agent_spawn',toolCallId:'repair-spawn',content:result.content,details:result.details,isError:false,timestamp:Date.now()});
				if (${JSON.stringify(scenario)} === 'repair-edit') {
					const input = {operation:'request',targetAgent:result.details.agentId,question:'Publish the release'};
					const entryId = runtime.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall('agent_message',input,{id:'repair-damaged-title'}),{stopReason:'toolUse'}));
					const requestMessageId = deriveMessageIdentity({agentId:runtime.session.sessionManager.getSessionId(),entryId,toolCallId:'repair-damaged-title'});
					runtime.session.sessionManager.appendMessage({role:'toolResult',toolName:'agent_message',toolCallId:'repair-damaged-title',content:[],details:{requestMessageId,targetAgentId:result.details.agentId,messageStatus:'sent'},isError:false,timestamp:Date.now()});
				}
				writeFileSync(${JSON.stringify(join(root, "spawn.json"))}, JSON.stringify(result.details));
			}});
			pi.registerCommand('repair-test-bash', {handler:async () => {
				void runtime.session.executeBash('echo BASH_STARTED; sleep 30', chunk => {
					if (chunk.includes('BASH_STARTED')) writeFileSync(${JSON.stringify(join(root, "bash-started"))}, 'started');
				});
			}});
			pi.registerCommand('repair-test-ping', {handler:(_args,ctx) => writeFileSync(${JSON.stringify(join(root, "ping.json"))}, JSON.stringify({pid:process.pid,path:ctx.sessionManager.getSessionFile(),nativeManagerReplaced:ctx.sessionManager !== globalThis.__repairOriginalManager,entries:ctx.sessionManager.getEntries()}))});
			pi.registerCommand('repair-test-quit', {handler:(_args,ctx) => ctx.shutdown()});
			pi.registerCommand('repair-test-clear-failure', {handler:() => clearNativeFailure?.()});
			pi.registerCommand('repair-test-open', {handler:async (path,ctx) => {await ctx.switchSession(path);}});
			pi.registerCommand('repair-test-inspect', {handler:async (_args,ctx) => {
				const command = runtime.session.extensionRunner.getCommand('agents');
				const ui = {...ctx.ui, notify:(message,type) => {writeFileSync(${JSON.stringify(join(root, "inspected.json"))},JSON.stringify({message}));ctx.ui.notify(message,type);}};
				await command.handler('repair inspect',{...ctx,ui});
			}});
		}`);
	const terminal = pty.spawn(process.execPath, [resolveInstalledPiCliPath(), "--session", ownerPath,
		"--no-extensions", "--extension", process.env.REPAIR_TEST_EXTENSION ?? resolve("src/index.ts"), "--extension", fixturePath,
		"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
		"--model", `${server.provider}/${server.modelId}`, "--thinking", "off"],
		{ cwd: root, cols: 100, rows: 35, name: "xterm-256color", env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" } });
	terminal.onData((chunk) => appendFileSync(join(root, "terminal.log"), chunk));
	const exited = new Promise<void>((done) => terminal.onExit(() => done()));
	try {
		await until(() => existsSync(join(root, "ready.json")), `Owner startup (${root})`);
		if (scenario === "managed-child" || scenario === "repair-edit") {
			terminal.write("/repair-test-spawn\r");
			await until(() => existsSync(join(root, "spawn.json")), "actual managed child spawn");
			assert.equal(JSON.parse(await readFile(join(root, "spawn.json"), "utf8")).spawnStatus, "created");
			await until(async () => existsSync(join(root, "child-settled")) && (await readFile(join(root, "child-settled"), "utf8")).trim().split("\n").length >= 2, "managed child settlement");
		}
		if (scenario === "bash") { terminal.write("/repair-test-bash\r"); await until(() => existsSync(join(root, "bash-started")), "native user bash started"); }
		ordinaryRequestsBeforeRepair = ordinaryRequests;
		terminal.write("/agents repair\r");
		const repairRoot = join(root, "pi-agent-coordination-repair", Buffer.from(ownerId).toString("base64url"));
		if (scenario === "cancel") { await until(() => repairRequests > 0, "repair model started"); terminal.write("\u001b"); }
		if (scenario === "helper-kill") {
			await until(() => repairRequests > 0, "repair model started");
			const [attemptId] = await readdir(join(repairRoot, "hosts"));
			const helper = JSON.parse(await readFile(join(repairRoot, "hosts", attemptId, "helper.json"), "utf8"));
			assert.notEqual(helper.pid, terminal.pid);
			process.kill(helper.pid, "SIGKILL");
		}
		const refused = scenario === "cleanup-reject" || scenario === "parking-cancel" || scenario === "cancel" || scenario === "helper-kill";
		await until(async () => {
			if (!existsSync(join(repairRoot, "hosts"))) return false;
			const [id] = await readdir(join(repairRoot, "hosts"));
			if (refused) {
				return existsSync(join(repairRoot, "hosts", id, "outcome.json"));
			}
			return existsSync(join(repairRoot, "hosts", id, "admission.jsonl"));
		}, `repair admission (${root})`);
		const [id] = await readdir(join(repairRoot, "hosts"));
		const directory = join(repairRoot, "hosts", id);
		const secondAttempt = async () => {
			await delay(250);
			terminal.write("/agents repair\r");
			let nextId: string | undefined;
			await until(async () => {
				nextId = (await readdir(join(repairRoot, "hosts"))).find((value) => value !== id);
				return !!nextId && existsSync(join(repairRoot, "hosts", nextId, "outcome.json"));
			}, "second authorized attempt in same CLI");
			assert.equal(JSON.parse(await readFile(join(repairRoot, "hosts", nextId!, "outcome.json"), "utf8")).outcome, "admitted");
			assert.notEqual(nextId, id);
			return nextId!;
		};
		if (refused) {
			assert.equal(existsSync(join(repairRoot, "storage", id, "committed.json")), false);
			if (scenario === "cleanup-reject" || scenario === "parking-cancel") assert.equal(existsSync(join(repairRoot, "storage", id, "manifest.json")), false);
			if (scenario === "cleanup-reject") {
				terminal.write("/repair-test-clear-failure\r");
				await delay(50);
				terminal.write("/agents repair park\r");
				await until(async () => JSON.parse(await readFile(join(root, "ready.json"), "utf8")).path.endsWith("repair-host.jsonl"), "park refused Owner without authorizing repair");
				// session_start precedes the awaited replacement callback and editor rebind.
				await delay(250);
				terminal.write("/agents repair recover\r");
				await until(async () => (await readFile(join(root, "terminal.log"), "utf8")).includes("no verified retirement handoff"), "ordinary recovery must refuse missing handoff");
				assert.equal(existsSync(join(directory, "admission.jsonl")), false);
				terminal.write("/agents repair recover-stopped\r");
				await until(() => existsSync(join(directory, "admission.jsonl")), "explicit stopped-writer attestation may recover preapply state");
				assert.equal(JSON.parse((await readFile(join(directory, "admission.jsonl"), "utf8")).trim()).admitted, true);
			}
			if (scenario === "helper-kill") {
				terminal.write("/agents repair recover-stopped\r");
				await until(() => existsSync(join(directory, "admission.jsonl")), "explicit recovery after helper interruption");
				const recovery = JSON.parse((await readFile(join(directory, "recovery.jsonl"), "utf8")).trim());
				assert.equal(recovery.kind, "operator-attested");
				assert.equal(recovery.helperRetirement.kind, "observed-exit");
				assert.equal(recovery.helperRetirement.signal, "SIGKILL");
				assert.equal(JSON.parse((await readFile(join(directory, "admission.jsonl"), "utf8")).trim()).admitted, true);
				assert.equal(existsSync(join(repairRoot, "storage", "lease")), false);
			}
			if (scenario === "cancel") {
				await delay(250);
				terminal.write("/agents repair recover\r");
				await until(() => existsSync(join(directory, "admission.jsonl")), "ordinary recovery after positively acknowledged retirement");
				assert.equal(JSON.parse((await readFile(join(directory, "admission.jsonl"), "utf8")).trim()).admitted, true);
				await secondAttempt();
			}
			return;
		}
		const admission = JSON.parse((await readFile(join(directory, "admission.jsonl"), "utf8")).trim());
		assert.equal(admission.admitted, scenario !== "admission-fail" && scenario !== "initial-admission-fail", root);
		const bootstrap = JSON.parse(await readFile(join(directory, "moderator-bootstrap.json"), "utf8"));
		assert.equal(bootstrap.workflowId, ownerId);
		assert.equal(bootstrap.directSpawnerAgentId, null);
		assert.notEqual(bootstrap.agentId, ownerId);
		assert.equal(bootstrap.kind, "repair_moderator");
		assert.ok(existsSync(join(repairRoot, "storage", id, "committed.json")));
		const snapshot = await readFile(join(repairRoot, "storage", id, "snapshot", "file-0"), "utf8");
		assert.match(snapshot, /repair-test-final-write/);
		if (scenario === "managed-child" || scenario === "repair-edit") {
			const childSnapshot = await readFile(join(repairRoot, "storage", id, "snapshot", "file-1"), "utf8");
			assert.match(childSnapshot, /repair-test-final-write/);
			const finalWrite = childSnapshot.trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.customType === "repair-test-final-write");
			assert.notEqual(finalWrite.data.pid, terminal.pid);
		}
		if (scenario === "repair-edit") {
			assert.doesNotMatch(snapshot, /"title":"Publish release"/);
			assert.match(await readFile(ownerPath, "utf8"), /"title":"Publish release"/);
			const [sealId] = await readdir(join(repairRoot, "storage", id, "seals"));
			const audit = JSON.parse(await readFile(join(repairRoot, "storage", id, "seals", sealId, "report.txt"), "utf8"));
			assert.equal(audit.valid, true);
			assert.ok(audit.protocolEffects.changes.some((change: { category: string }) => change.category === "pending_delivery"));
		}
		if (scenario === "bash") {
			assert.match(snapshot, /BASH_STARTED/);
			assert.match(snapshot, /"cancelled":true/);
		}
		await delay(50);
		terminal.write("/repair-test-ping\r");
		await until(() => existsSync(join(root, "ping.json")), "same terminal input after repair");
		const ping = JSON.parse(await readFile(join(root, "ping.json"), "utf8"));
		assert.equal(ping.pid, terminal.pid);
		assert.equal(ping.path, ownerPath);
		assert.equal(ping.nativeManagerReplaced, true);
		assert.equal(SessionManager.open(ownerPath).getSessionId(), ownerId);
		assert.equal(ordinaryRequests, ordinaryRequestsBeforeRepair, "repair must not automatically resume participants");
		assert.equal(repairRequests, scenario === "repair-edit" ? 4 : 2);
		if (scenario === "repeat") {
			const nextId = await secondAttempt();
			await delay(250);
			terminal.write(`/repair-test-open ${join(directory, "repair-host.jsonl")}\r`);
			await until(async () => JSON.parse(await readFile(join(root, "ready.json"), "utf8")).path === join(directory, "repair-host.jsonl"), "open archived first repair host");
			await delay(250);
			terminal.write("/repair-test-inspect\r");
			await until(() => existsSync(join(root, "inspected.json")), "archived host inspection");
			const inspected = JSON.parse(await readFile(join(root, "inspected.json"), "utf8"));
			assert.ok(inspected.message.includes(id));
			assert.equal(inspected.message.includes(nextId), false);
			terminal.write("q");
		}
	} finally {
		releaseModel?.();
		terminal.kill();
		await exited;
		await server.close();
	}
});
}
