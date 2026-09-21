import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";

import {
	fauxAssistantMessage,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";

import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

const PROVIDER_ID = "coordination-test";
const MODEL_ID = "deterministic-owner";

test("Owner hosts use the in-memory model unless child processes need the provider", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	assert.equal(
		host.services.resourceLoader.getExtensions().extensions.some(
			(extension) => extension.resolvedPath.endsWith("process-model-broker-extension.mjs"),
		),
		false,
	);

	const model = host.services.modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
	assert.ok(model);
	host.model.setResponses([fauxAssistantMessage("In-memory response.")]);
	const response = await host.services.modelRuntime.completeSimple(model, { messages: [] });
	assert.equal(textOf(response.content), "In-memory response.");
});

test("opt-in Owner model calls use the retained file-backed broker until runtime disposal", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		processVisibleModel: true,
		fauxTokensPerSecond: 100_000,
	});
	const generatedExtension = host.services.resourceLoader.getExtensions().extensions.find(
		(extension) => extension.resolvedPath.endsWith("process-model-broker-extension.mjs"),
	);
	assert.ok(generatedExtension);
	assert.equal((await lstat(generatedExtension.resolvedPath)).isFile(), true);

	const model = host.services.modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
	assert.ok(model);
	assert.match(model.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/response$/);
	const fallback = await host.services.modelRuntime.completeSimple(model, { messages: [] });
	assert.equal(textOf(fallback.content), "Owner interaction preserved.");

	let configuredCalls = 0;
	host.model.setResponses([
		(context, options, state, requestModel) => {
			configuredCalls += 1;
			assert.deepEqual(context, { messages: [{ role: "system", content: "Owner proxy evidence", timestamp: 0 }, ...ordinaryContext.messages] });
			assert.ok(options?.signal instanceof AbortSignal);
			assert.equal(state.callCount, 2);
			assert.equal(requestModel.provider, PROVIDER_ID);
			return fauxAssistantMessage("Configured broker response.");
		},
	]);
	const implicit = await host.services.modelRuntime.completeSimple(model, implicitModeratorContext);
	assert.equal(textOf(implicit.content), "I will wait for explicit Moderator work.");
	const configured = await host.services.modelRuntime.completeSimple(model, ordinaryContext);
	assert.equal(textOf(configured.content), "Configured broker response.");
	assert.equal(configuredCalls, 1);

	await host.runtime.dispose();
	await assert.rejects(lstat(generatedExtension.resolvedPath), hasCode("ENOENT"));
});

const implicitModeratorContext: Context = {
	messages: [{
		role: "user",
		content: [{ type: "text", text: '{"kind":"obligation_stall"}' }],
		timestamp: 1,
	}],
	tools: [{
		name: "moderator_control",
		description: "Moderate work",
		parameters: { type: "object" },
	}],
};

const ordinaryContext: Context = {
	systemPrompt: "Owner proxy evidence",
	messages: [{ role: "user", content: "Use the configured response.", timestamp: 2 }],
};

function textOf(content: AssistantMessage["content"]): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
