import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

function customMessage(kind: "message" | "request", id: string) {
	const source = { agentId: "startup-author", entryId: "startup-entry", toolCallId: id };
	return createMessageDelivery([{ source, projection: kind === "message"
		? { kind, messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content: "Run the startup tool." }
		: { kind, requestMessageId: deriveMessageIdentity(source), fromAgentId: source.agentId, title: "Startup", question: "Run the startup tool." },
	}]);
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => { resolve = yes; });
	return { promise, resolve };
}

async function within<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Admission did not settle without unrelated preparation")), 300);
		})]);
	} finally { clearTimeout(timer); }
}

function onPreparation(pi: ExtensionAPI, phase: "input" | "before_agent_start", handler: () => void | Promise<void>) {
	if (phase === "input") pi.on("input", handler);
	else pi.on("before_agent_start", handler);
}

async function fixture(t: Parameters<typeof createTestOwnerHost>[0], extension: ExtensionFactory = () => {}) {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		fauxTokensPerSecond: 100_000, additionalExtensionFactories: [extension],
	});
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const message = customMessage("message", "adversarial");
	const deliveries = () => host.session.sessionManager.getEntries().filter(entry =>
		entry.type === "custom_message" && entry.content === message.content);
	const deliver = () => runtime.deliver({ kind: "custom", message, triggerTurn: true, deliverAs: "followUp" }).completion;
	return { ...host, hosted: runtime, message, deliveries, deliver };
}

for (const rejected of ["handled", "missing auth"] as const) {
	test(`${rejected} custom preflight leaves no Delivery or queued kickoff; explicit retry commits once`, { timeout: 5000 }, async t => {
		let handled = rejected === "handled";
		const host = await fixture(t, pi => { pi.on("input", () => handled ? { action: "handled" } : undefined); });
		const model = host.session.model;
		assert.ok(model);
		if (rejected === "missing auth") host.session.agent.state.model = { ...model, provider: "startup-no-auth" };
		host.model.setResponses([fauxAssistantMessage("Retry accepted.")]);
		await assert.rejects(host.deliver(), rejected === "handled" ? /custom_startup_not_started/ : /API key|Authentication/);
		assert.equal(host.deliveries().length, 0);
		assert.equal(host.session.pendingMessageCount, 0);
		handled = false;
		if (rejected === "missing auth") host.session.agent.state.model = model;
		await host.deliver();
		assert.equal(host.deliveries().length, 1);
	});
}

for (const phase of ["input", "before_agent_start"] as const) {
	for (const text of ["nested text", ""] as const) {
		test(`nested ${JSON.stringify(text)} during ${phase} is rejected before it can prepare or consume Delivery`, { timeout: 5000 }, async t => {
			let nested!: () => Promise<void>;
			let nestedEntries = 0;
			let nestedError: unknown;
			const host = await fixture(t, pi => {
				onPreparation(pi, phase, async () => {
					nestedEntries++;
					if (nestedEntries === 1) nestedError = await nested().then(() => undefined, error => error);
				});
			});
			nested = () => host.session.prompt(text, { source: "extension" });
			host.model.setResponses([fauxAssistantMessage("Only outer input ran.")]);
			await host.deliver();
			assert.match(String(nestedError), /startup_preparation_busy/);
			assert.equal(nestedEntries, 1);
			assert.equal(host.deliveries().length, 1);
			assert.equal(host.session.messages.filter(message => message.role === "user").length, 1);
		});
	}
	test(`prompt and custom entrypoints reject competitors during ${phase}; active input queues after native entry`, { timeout: 5000 }, async t => {
		const preparing = deferred();
		const releasePreparation = deferred();
		const modelStarted = deferred();
		const releaseModel = deferred();
		t.after(() => { releasePreparation.resolve(); releaseModel.resolve(); });
		let preparations = 0;
		const host = await fixture(t, pi => {
			onPreparation(pi, phase, async () => { preparations++; if (preparations === 1) { preparing.resolve(); await releasePreparation.promise; } });
			pi.on("before_agent_start", () => ({ systemPrompt: "Original prepared prompt." }));
		});
		const contexts: Context[] = [];
		host.model.setResponses([
			async context => { contexts.push(context); modelStarted.resolve(); await releaseModel.promise; return fauxAssistantMessage("First response."); },
			context => { contexts.push(context); return fauxAssistantMessage("Queued input processed."); },
		]);
		const delivery = host.deliver();
		await preparing.promise;
		await assert.rejects(host.session.prompt("competitor"), /startup_preparation_busy/);
		await assert.rejects(host.session.sendCustomMessage(customMessage("message", "competitor"), { triggerTurn: true }), /startup_preparation_busy/);
		assert.equal(preparations, 1);
		assert.equal(host.session.pendingMessageCount, 0);
		releasePreparation.resolve();
		await modelStarted.promise;
		await host.session.prompt("queued human input", { streamingBehavior: "followUp" });
		releaseModel.resolve();
		await delivery;
		assert.equal(contexts.length, 2);
		assert.ok(contexts.every(context => context.systemPrompt === "Original prepared prompt."));
		assert.equal(host.deliveries().length, 1);
	});

	test(`abort during ${phase} cancels only the pending custom startup and allows explicit retry`, { timeout: 5000 }, async t => {
		const preparing = deferred();
		const release = deferred();
		t.after(release.resolve);
		let block = true;
		const host = await fixture(t, pi => { onPreparation(pi, phase, async () => { if (block) { preparing.resolve(); await release.promise; } }); });
		host.model.setResponses([fauxAssistantMessage("Retry completed.")]);
		const rejected = assert.rejects(host.deliver(), /startup_admission_cancelled/);
		await preparing.promise;
		await host.session.abort();
		block = false;
		release.resolve();
		await rejected;
		assert.equal(host.deliveries().length, 0);
		assert.equal(host.session.pendingMessageCount, 0);
		await host.deliver();
		assert.equal(host.deliveries().length, 1);
	});
}

test("Owner custom delivery waits for competing preparation and keeps its follow-up mode without fencing that Run", { timeout: 5000 }, async t => {
	const preparing = deferred();
	const releasePreparation = deferred();
	const modelStarted = deferred();
	const releaseModel = deferred();
	t.after(() => { releasePreparation.resolve(); releaseModel.resolve(); });
	let first = true;
	const host = await fixture(t, pi => { pi.on("input", async () => { if (first) { first = false; preparing.resolve(); await releasePreparation.promise; } }); });
	const contexts: string[] = [];
	host.model.setResponses([
		async context => { contexts.push(JSON.stringify(context)); modelStarted.resolve(); await releaseModel.promise; return fauxAssistantMessage("Human run intact."); },
		context => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage("Custom follow-up completed."); },
	]);
	const human = host.session.prompt("original human work");
	await preparing.promise;
	const delivery = host.deliver();
	releasePreparation.resolve();
	await modelStarted.promise;
	await delivery;
	assert.equal(host.session.agent.signal?.aborted, false);
	assert.equal(contexts[0].includes("Run the startup tool."), false);
	releaseModel.resolve();
	await human;
	assert.equal(contexts.length, 2);
	assert.ok(contexts[1].includes("Run the startup tool."));
	assert.equal(host.deliveries().length, 1);
});

test("abort also fences a custom dispatch waiting for another prompt's preparation", { timeout: 5000 }, async t => {
	const preparing = deferred();
	const release = deferred();
	t.after(release.resolve);
	const host = await fixture(t, pi => { pi.on("input", async () => { preparing.resolve(); await release.promise; }); });
	const human = assert.rejects(host.session.prompt("preparing human input"), /startup_admission_cancelled/);
	await preparing.promise;
	const delivery = assert.rejects(host.deliver(), /startup_admission_cancelled/);
	await host.session.abort();
	await within(delivery);
	release.resolve();
	await human;
	assert.equal(host.deliveries().length, 0);
	assert.equal(host.session.messages.length, 0);
});

test("Owner reminder returns busy while another prompt prepares and never joins its native queue", { timeout: 5000 }, async t => {
	const preparing = deferred();
	const release = deferred();
	t.after(release.resolve);
	const host = await fixture(t, pi => { pi.on("input", async () => { preparing.resolve(); await release.promise; }); });
	host.model.setResponses([fauxAssistantMessage("Unrelated run.")]);
	const human = host.session.prompt("unrelated work");
	await preparing.promise;
	assert.equal(await within(host.hosted.deliverModeratorReminder(commit => commit())), "busy");
	release.resolve();
	await human;
	assert.equal(host.session.messages.some(message => message.role === "custom" && message.customType.includes("moderator-obligation-reminder")), false);
});

test("idle delivery composes with an existing public custom-message wrapper across reload", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	const original = host.session.sendCustomMessage;
	const observed: unknown[] = [];
	host.session.sendCustomMessage = (message, options) => {
		observed.push(message);
		return original.call(host.session, message, options);
	};
	host.model.setResponses([fauxAssistantMessage("Wrapper preserved."), fauxAssistantMessage("Reload wrapper preserved.")]);
	await host.deliver();
	assert.deepEqual(observed, [host.message]);
	assert.equal(host.deliveries().length, 1);
	await host.session.reload();
	const next = customMessage("message", "wrapper-after-reload");
	await host.hosted.deliver({ kind: "custom", message: next, triggerTurn: true }).completion;
	assert.deepEqual(observed, [host.message, next]);
});

test("reload keeps late preparation excluded until the cancelled generation unwinds", { timeout: 5000 }, async t => {
	const preparing = deferred();
	const release = deferred();
	t.after(release.resolve);
	let first = true;
	const host = await fixture(t, pi => { pi.on("before_agent_start", async () => {
		if (first) { first = false; preparing.resolve(); await release.promise; return { systemPrompt: "Retired preparation." }; }
		return { systemPrompt: "Current preparation." };
	}); });
	const retired = assert.rejects(host.deliver(), /startup_admission_cancelled/);
	await preparing.promise;
	await host.session.reload();
	await assert.rejects(host.session.prompt("competing replacement"), /startup_preparation_busy/);
	release.resolve();
	await retired;
	const prompts: string[] = [];
	host.model.setResponses([context => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("Current run."); }]);
	await host.deliver();
	assert.deepEqual(prompts, ["Current preparation."]);
	assert.equal(host.deliveries().length, 1);
});

test("Owner native input forwarding hands off only its handled submission and prepares one replacement Run", { timeout: 5000 }, async t => {
	let forward!: (text: string) => Promise<unknown>;
	let preparations = 0;
	const errors: unknown[] = [];
	const host = await fixture(t, pi => {
		pi.on("input", async event => {
			if (event.source !== "interactive") return;
			try { await forward(event.text); } catch (error) { errors.push(error); }
			return { action: "handled" };
		});
		pi.on("before_agent_start", () => { preparations++; return { systemPrompt: "Prepared forwarded input." }; });
	});
	forward = async text => {
		const dispatched = host.hosted.deliver({ kind: "user", content: text, forwardedInput: {} }, {
			inspectCommit: () => host.session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(text)),
		});
		void dispatched.completion.catch(() => {});
		assert.equal(await dispatched.transcriptCommit, true);
	};
	const prompts: string[] = [];
	host.model.setResponses([context => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("Forwarded input completed."); }]);
	await host.session.prompt("Resume my work.");
	await host.session.waitForIdle();
	assert.deepEqual(errors, []);
	assert.equal(preparations, 1);
	assert.deepEqual(prompts, ["Prepared forwarded input."]);
	assert.equal(host.session.messages.filter(message => message.role === "user").length, 1);
});

test("Owner reload restores composed wrappers and the next idle delivery prepares exactly once", { timeout: 5000 }, async t => {
	let preparations = 0;
	const host = await fixture(t, pi => { pi.on("before_agent_start", () => { preparations++; }); });
	const original = host.session.prompt;
	let outerCalls = 0;
	const outer: typeof original = (...args) => { outerCalls++; return original.apply(host.session, args); };
	host.session.prompt = outer;
	host.model.setResponses([fauxAssistantMessage("Before reload."), fauxAssistantMessage("After reload.")]);
	await host.deliver();
	await host.session.reload();
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	await runtime.deliver({ kind: "custom", message: customMessage("message", "after-reload"), triggerTurn: true }).completion;
	assert.equal(preparations, 2);
	assert.equal(outerCalls, 2);
});

for (const kind of ["message", "request"] as const) {
	test(`Owner prepares first and settled ${kind} deliveries through a tool continuation`, { timeout: 10_000 }, async t => {
		let inputs = 0;
		let preparations = 0;
		let tools = 0;
		const prompts: string[] = [];
		const host = await createTestOwnerHost(t, piAgentCoordination, {
			fauxTokensPerSecond: 100_000,
			additionalExtensionFactories: [pi => {
				pi.registerTool({ name: "startup_tool", label: "Startup tool", description: "A harmless startup regression tool.",
					parameters: Type.Object({}), async execute() {
						tools += 1;
						return { content: [{ type: "text", text: "startup tool completed" }], details: undefined };
					},
				});
				pi.on("input", event => { if (event.source === "extension") inputs += 1; });
				pi.on("before_agent_start", event => {
					preparations += 1;
					return { systemPrompt: event.systemPrompt + "\nUse startup_tool to complete the startup check." };
				});
			}],
		});
		const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.runtime.services, projection: undefined });
		const record = (response: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			prompts.push(context.systemPrompt ?? "");
			return response;
		};
		host.model.setResponses(Array.from({ length: 2 }, () => [
			record(fauxAssistantMessage(fauxToolCall("startup_tool", {}), { stopReason: "toolUse" })),
			record(fauxAssistantMessage("Startup complete.")),
		]).flat());
		const messages = [customMessage(kind, "first"), customMessage(kind, "second")];
		for (const message of messages) {
			const dispatch = runtime.deliver({ kind: "custom", message, triggerTurn: true, deliverAs: "followUp" }, {
				inspectCommit: () => host.session.sessionManager.getEntries().some(entry =>
					entry.type === "custom_message" && entry.content === message.content),
			});
			assert.equal(await dispatch.transcriptCommit, true);
			await dispatch.completion;
			assert.equal(host.session.isIdle, true);
		}
		assert.equal(inputs, 2);
		assert.equal(preparations, 2);
		assert.equal(tools, 2);
		assert.equal(prompts.length, 4);
		assert.ok(prompts.every(prompt => prompt.includes("Use startup_tool to complete the startup check.")));
		const deliveries = host.session.sessionManager.getEntries().filter(entry =>
			entry.type === "custom_message" && entry.customType === messages[0].customType);
		assert.equal(deliveries.length, 2);
		for (const [index, entry] of deliveries.entries()) {
			assert.equal(entry.type, "custom_message");
			if (entry.type !== "custom_message") continue;
			const { customType, content, display, details } = entry;
			assert.deepEqual({ customType, content, display, details }, messages[index]);
		}
		assert.equal(host.session.pendingMessageCount, 0);
	});
}
