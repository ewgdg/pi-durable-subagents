import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	transcriptFromSessionFile,
	transcriptFromSessionManager,
} from "../src/pi-integration/session-manager-transcript.ts";
import { findAuthoredRequestSources } from "../src/protocol/request-resolution.ts";
import {
	createMessageDelivery,
	inspectMessageDeliveries,
} from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";

test("incremental facts equal clean reconstruction across appends, compaction and scope replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-facts-"));
	const file = join(root, "session.jsonl");
	const manager = SessionManager.inMemory(root, { id: "facts" });
	const identity = manager.appendCustomEntry("agent-coordination.identity", { agentId: "facts" });
	await writeFile(
		file,
		`${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	const local = transcriptFromSessionManager(manager);
	const remote = transcriptFromSessionFile(file);
	let written = manager.getEntries().length;
	const sources = (transcript: ReturnType<typeof local.inspect>) =>
		findAuthoredRequestSources({ authorAgentId: "facts", transcript });
	const deliveries = (transcript: ReturnType<typeof local.inspect>) =>
		inspectMessageDeliveries({ recipientAgentId: "facts", transcript });
	for (const transcript of [local.inspect(), remote.inspect()]) {
		assert.deepEqual(sources(transcript), []);
		assert.deepEqual(deliveries(transcript), []);
	}
	const toolCallId = "request-one";
	const entryId = manager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: "facts",
					question: "Retain this obligation.",
				},
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
	);
	const source = { agentId: "facts", entryId, toolCallId };
	const delivery = createMessageDelivery([
		{
			source,
			projection: {
				title: "Fixture request",
				kind: "request",
				requestMessageId: deriveMessageIdentity(source),
				fromAgentId: "facts",
				question: "Retain this obligation.",
			},
		},
	]);
	manager.appendCustomMessageEntry(
		delivery.customType,
		delivery.content,
		delivery.display,
		delivery.details,
	);
	await compare();
	const retained = sources(remote.inspect());
	assert.equal(sources(remote.inspect()), retained);
	manager.branch(identity);
	manager.appendCompaction("A different active branch.", identity, 0);
	await compare();
	assert.equal(sources(remote.inspect()).length, 1);
	assert.equal(remote.diagnostics()?.reconstructions, 1);
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "facts" });
	await compare();
	assert.equal(sources(remote.inspect()).length, 0);
	assert.equal(deliveries(remote.inspect()).length, 0);

	async function compare() {
		const additions = manager.getEntries().slice(written);
		await appendFile(file, `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		written += additions.length;
		await Promise.all([local.refresh(), remote.refresh()]);
		const rebuilt = transcriptFromSessionManager(SessionManager.open(file)).inspect();
		for (const transcript of [local.inspect(), remote.inspect()]) {
			assert.deepEqual(sources(transcript), sources(rebuilt));
			assert.deepEqual(deliveries(transcript), deliveries(rebuilt));
		}
	}
});
