import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";

import { MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createChildControlLoopback, loopbackOwnerHandlers } from "./support/child-control-loopback.ts";
import {
	registerStartupProbe,
	STARTUP_GUIDANCE,
	STARTUP_TOOL,
	STARTUP_TOOL_RESULT,
	type StartupProbeEvent,
} from "./fixtures/idle-custom-startup-extension.ts";

for (const kind of ["message", "request"] as const) {
	test(`a child prepares its first idle ${kind} and its settled wake through a tool round trip`, { timeout: 5_000 }, async t => {
		const child = await startChild(t);
		for (const turn of [1, 2]) {
			const source = { agentId: "startup-sender", entryId: `startup-${kind}-${turn}`, toolCallId: `send-${kind}-${turn}` };
			const messageId = deriveMessageIdentity(source);
			const content = `Prepared ${kind} wake ${turn}`;
			const message = createMessageDelivery([{
				source,
				projection: kind === "message"
					? { kind, messageId, fromAgentId: source.agentId, content }
					: { kind, requestMessageId: messageId, fromAgentId: source.agentId, title: content, question: content },
			}]);
			await child.loopback.proxy.deliver({ kind: "custom", message, triggerTurn: true }).completion;
			const entries = child.entries();
			const committed = entries.filter(entry => entry.type === "custom_message" && entry.content === message.content);
			assert.equal(committed.length, 1, "the original Message must have one canonical Delivery");
			const entry = committed[0];
			assert.ok(entry?.type === "custom_message");
			assert.deepEqual({ customType: entry.customType, content: entry.content, display: entry.display, details: entry.details }, message);
			child.assertPreparedTurn(turn);
			const kickoffs = entries.filter(candidate => candidate.type === "message" && candidate.message.role === "user");
			assert.ok(entries.indexOf(kickoffs.at(-1)!) < entries.indexOf(entry), "the empty kickoff precedes canonical Delivery");
		}
		assert.equal(child.humanInputs(), 0, "empty extension kickoffs must not create Human Requests");
	});
}

test("a child prepares the separate Moderator reminder startup on first and settled Runs", { timeout: 5_000 }, async t => {
	const child = await startChild(t);
	for (const turn of [1, 2]) {
		const settled = new Promise<void>(resolve => {
			const remove = child.loopback.proxy.subscribe(event => {
				if (event.type !== "agent_settled") return;
				remove();
				resolve();
			});
		});
		assert.equal(await child.loopback.proxy.deliverModeratorReminder(commit => commit()), "committed");
		await settled;
		const reminders = child.entries().filter(entry =>
			entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE);
		assert.equal(reminders.length, turn, "each admitted reminder commits exactly once");
		child.assertPreparedTurn(turn);
	}
	assert.equal(child.humanInputs(), 0);
});

async function startChild(t: Parameters<typeof createChildControlLoopback>[0]) {
	const probe: StartupProbeEvent[] = [];
	const contexts: Context[] = [];
	let humanInputs = 0;
	const owner = loopbackOwnerHandlers();
	const loopback = await createChildControlLoopback(t, {
		owner: { ...owner, lifecycle: { ...owner.lifecycle, humanInputSubmitted: async () => { humanInputs++; return "continue"; } } },
		configure: pi => registerStartupProbe(pi, event => probe.push(event)),
		host: { implicitModeratorResponses: false },
	});
	loopback.host.model.setResponses(Array.from({ length: 4 }, (_, call) => (context: Context) => {
		contexts.push(context);
		return call % 2 === 0
			? fauxAssistantMessage(fauxToolCall(STARTUP_TOOL, {}, { id: `startup-probe-${call}` }), { stopReason: "toolUse" })
			: fauxAssistantMessage("Prepared startup completed.");
	}));
	const entries = () => loopback.host.session.sessionManager.getEntries();
	return {
		loopback,
		entries,
		humanInputs: () => humanInputs,
		assertPreparedTurn(turn: number) {
			assert.equal(contexts.length, turn * 2, "each idle start executes one registered tool and its continuation");
			for (const context of contexts.slice((turn - 1) * 2)) {
				assert.ok(getCurrentTools(context.messages).some(tool => tool.name === STARTUP_TOOL));
				assert.ok(getCurrentSystemPrompt(context.messages).includes(STARTUP_GUIDANCE), "idle custom Runs must receive before-start tool guidance, including after the tool result");
				assert.ok(getCurrentSystemPrompt(context.messages).includes(`Startup input ${turn}; preparation ${turn}.`));
			}
			const toolResult = contexts.at(-1)?.messages.findLast(message => message.role === "toolResult");
			assert.ok(toolResult?.role === "toolResult");
			assert.equal(toolResult.isError, false);
			assert.match(JSON.stringify(toolResult.content), new RegExp(STARTUP_TOOL_RESULT));
			assert.deepEqual(probe.filter(event => event.phase === "input"),
				Array.from({ length: turn }, () => ({ phase: "input", text: "", source: "extension" })));
			assert.deepEqual(probe.filter(event => event.phase === "prepare"),
				Array.from({ length: turn }, (_, index) => ({ phase: "prepare", inputs: index + 1, preparations: index + 1 })));
			assert.equal(probe.filter(event => event.phase === "tool").length, turn);
			const kickoffs = entries().filter(entry => entry.type === "message" && entry.message.role === "user");
			assert.equal(kickoffs.length, turn, "each idle Run commits exactly one empty kickoff");
			for (const entry of kickoffs) {
				assert.ok(entry.type === "message" && entry.message.role === "user");
				const content = entry.message.content;
				assert.equal(typeof content === "string" ? content : content.map(part => part.type === "text" ? part.text : "image").join(""), "");
			}
		},
	};
}
