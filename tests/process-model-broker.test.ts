import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
	createProcessModelBroker,
	type ProcessModelBroker,
} from "./support/process-model-broker.ts";

test("generated extension returns deterministic text, tool-call, and error messages", async () => {
	const observed: Array<{
		context: Context;
		options: SimpleStreamOptions | undefined;
		model: Model<string>;
		callCount: number;
	}> = [];
	const broker = await createProcessModelBroker();
	try {
		broker.setResponses([
			(context, options, state, model) => {
				observed.push({ context, options, model, callCount: state.callCount });
				return fauxAssistantMessage("broker text", { timestamp: 1_700_000_000_001 });
			},
			fauxAssistantMessage(
				fauxToolCall("record_evidence", { exact: true }, { id: "tool-call-1" }),
				{ stopReason: "toolUse", timestamp: 1_700_000_000_002 },
			),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "deterministic model failure",
				timestamp: 1_700_000_000_003,
			}),
		]);

		const provider = await loadGeneratedProvider(broker);
		const context: Context = {
			systemPrompt: "system evidence",
			messages: [{ role: "user", content: [{ type: "text", text: "user evidence" }], timestamp: 1 }],
			tools: [{ name: "record_evidence", description: "Record it", parameters: { type: "object" } }],
		};
		const options: SimpleStreamOptions = {
			reasoning: "low",
			sessionId: "session-evidence",
			maxTokens: 123,
		};

		const text = await provider.streamSimple(broker.model, context, options).result();
		const tool = await provider.streamSimple(broker.model, { messages: [] }).result();
		const failure = await provider.streamSimple(broker.model, { messages: [] }).result();

		assert.deepEqual(
			{ role: text.role, content: text.content, stopReason: text.stopReason, timestamp: text.timestamp },
			{
				role: "assistant",
				content: [{ type: "text", text: "broker text" }],
				stopReason: "stop",
				timestamp: 1_700_000_000_001,
			},
		);
		assert.deepEqual(tool.content, [{
			type: "toolCall",
			id: "tool-call-1",
			name: "record_evidence",
			arguments: { exact: true },
		}]);
		assert.deepEqual(
			{ stopReason: failure.stopReason, errorMessage: failure.errorMessage, content: failure.content },
			{ stopReason: "error", errorMessage: "deterministic model failure", content: [] },
		);
		assert.equal(tool.timestamp, 1_700_000_000_002);
		assert.equal(failure.timestamp, 1_700_000_000_003);
		for (const message of [text, tool, failure]) {
			assert.equal(message.api, broker.providerId);
			assert.equal(message.provider, broker.providerId);
			assert.equal(message.model, broker.modelId);
		}
		assert.equal(observed.length, 1);
		assert.deepEqual(observed[0]?.context, context);
		assert.equal(observed[0]?.options?.reasoning, "low");
		assert.equal(observed[0]?.options?.sessionId, "session-evidence");
		assert.equal(observed[0]?.options?.maxTokens, 123);
		assert.ok(observed[0]?.options?.signal instanceof AbortSignal);
		// The model crosses the broker as JSON, which drops undefined optional fields.
		assert.deepEqual(observed[0]?.model, JSON.parse(JSON.stringify(broker.model)));
		assert.equal(observed[0]?.callCount, 1);
	} finally {
		await broker.close();
	}
});

test("generated extension propagates cancellation and broker close removes runtime resources", async () => {
	const broker = await createProcessModelBroker();
	const extensionPath = broker.extensionPath;
	const runtimeDirectory = broker.runtimeDirectory;
	assert.equal((await lstat(extensionPath)).mode & 0o777, 0o600);
	assert.equal((await lstat(runtimeDirectory)).mode & 0o777, 0o700);
	let provider: RegisteredProvider | undefined;
	let markParentStarted: (() => void) | undefined;
	const parentStarted = new Promise<void>((resolve) => markParentStarted = resolve);
	let parentObservedAbort = false;
	try {
		broker.setResponses([
			async (_context, options) => {
				markParentStarted?.();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => {
						parentObservedAbort = true;
						resolve();
					}, { once: true });
				});
				return fauxAssistantMessage("must not complete");
			},
		]);
		provider = await loadGeneratedProvider(broker);
		const controller = new AbortController();
		const result = provider.streamSimple(
			broker.model,
			{ messages: [{ role: "user", content: "cancel me", timestamp: 2 }] },
			{ signal: controller.signal },
		).result();
		await parentStarted;
		controller.abort();

		const aborted = await result;
		assert.equal(aborted.stopReason, "aborted");
		assert.equal(aborted.errorMessage, "Request was aborted");
		await eventually(() => parentObservedAbort);
	} finally {
		await broker.close();
	}
	await broker.close();
	await assert.rejects(lstat(extensionPath), hasCode("ENOENT"));
	await assert.rejects(lstat(runtimeDirectory), hasCode("ENOENT"));
	assert.ok(provider);
	const afterClose = await provider.streamSimple(broker.model, { messages: [] }).result();
	assert.equal(afterClose.stopReason, "error");
	assert.match(afterClose.errorMessage ?? "", /fetch failed/i);
});

test("brokers are isolated concurrently and reject oversized request evidence", async () => {
	const first = await createProcessModelBroker({ maxPayloadBytes: 1_024 });
	const second = await createProcessModelBroker({ maxPayloadBytes: 1_024 });
	try {
		first.setResponses([fauxAssistantMessage("first broker")]);
		second.setResponses([fauxAssistantMessage("second broker")]);
		const [firstProvider, secondProvider] = await Promise.all([
			loadGeneratedProvider(first),
			loadGeneratedProvider(second),
		]);
		const [firstMessage, secondMessage] = await Promise.all([
			firstProvider.streamSimple(first.model, { messages: [] }).result(),
			secondProvider.streamSimple(second.model, { messages: [] }).result(),
		]);
		assert.equal(firstMessage.content[0]?.type === "text" && firstMessage.content[0].text, "first broker");
		assert.equal(secondMessage.content[0]?.type === "text" && secondMessage.content[0].text, "second broker");

		first.appendResponses([fauxAssistantMessage("y".repeat(2_000))]);
		const oversizedResponse = await firstProvider.streamSimple(first.model, { messages: [] }).result();
		assert.equal(oversizedResponse.stopReason, "error");
		assert.match(oversizedResponse.errorMessage ?? "", /payload exceeds 1024 bytes/i);

		const oversized = await firstProvider.streamSimple(first.model, {
			messages: [{ role: "user", content: "x".repeat(2_000), timestamp: 3 }],
		}).result();
		assert.equal(oversized.stopReason, "error");
		assert.match(oversized.errorMessage ?? "", /payload exceeds 1024 bytes/i);
	} finally {
		await Promise.all([first.close(), second.close()]);
	}
});

type RegisteredProvider = {
	streamSimple: (
		model: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};

async function loadGeneratedProvider(broker: ProcessModelBroker): Promise<RegisteredProvider> {
	let registered: RegisteredProvider | undefined;
	const extension = await import(`${pathToFileURL(broker.extensionPath).href}?test=${crypto.randomUUID()}`) as {
		default: (pi: { registerProvider(id: string, provider: RegisteredProvider): void }) => void;
	};
	extension.default({
		registerProvider(id, provider) {
			assert.equal(id, broker.providerId);
			registered = provider;
		},
	});
	assert.ok(registered);
	return registered;
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("condition was not observed");
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
