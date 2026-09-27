import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { runPrintMode, runRpcMode } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../../src/index.ts";
import { createManuallyManagedUnboundTestOwnerHost } from "../support/pi-host.ts";
import { latestRequestFromContext } from "../support/model-requests.ts";

const HEADLESS_OWNER_PROMPT = "Delegate the headless work.";
const HEADLESS_OWNER_DONE = "HEADLESS_OWNER_DONE";
const WAITED_REQUEST = "WAITED_REQUEST: report the waited result.";
const WAITED_ANSWER = "WAITED_ANSWER";
const ASYNC_REQUEST = "ASYNC_REQUEST: report the asynchronous result.";
const ASYNC_ANSWER = "ASYNC_ANSWER";

const mode = process.argv[2];
if (mode !== "rpc" && mode !== "print") throw new Error(`Unsupported headless mode: ${mode}`);

const host = await createManuallyManagedUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	processVisibleModel: true,
	fauxTokensPerSecond: 20_000,
});

// The Owner joins one Answer with agent_wait, then ends its turn after a second
// Request so that Answer can only arrive through asynchronous Delivery.
const route = (context: Context) => {
	const serialized = JSON.stringify(context.messages);
	if (!serialized.includes(HEADLESS_OWNER_PROMPT)) {
		const request = latestRequestFromContext(context);
		return fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				requestId: request.requestMessageId,
				answer: serialized.includes("ASYNC_REQUEST") ? ASYNC_ANSWER : WAITED_ANSWER,
			}),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("spawn-waited")) {
		return fauxAssistantMessage(
			fauxToolCall("agent_spawn", { title: "Waited work", request: WAITED_REQUEST }, { id: "spawn-waited" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("wait-for-answer")) {
		return fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "wait-for-answer" }), { stopReason: "toolUse" });
	}
	if (!serialized.includes("spawn-async")) {
		return fauxAssistantMessage(
			fauxToolCall("agent_spawn", { title: "Async work", request: ASYNC_REQUEST }, { id: "spawn-async" }),
			{ stopReason: "toolUse" },
		);
	}
	if (serialized.includes(ASYNC_ANSWER)) {
		return fauxAssistantMessage(`${HEADLESS_OWNER_DONE} ${serialized.includes(WAITED_ANSWER) ? WAITED_ANSWER : "missing"} ${ASYNC_ANSWER}`);
	}
	return fauxAssistantMessage("Waiting for the asynchronous Answer.");
};
host.model.setResponses(Array.from({ length: 30 }, () => route));

if (mode === "rpc") {
	await runRpcMode(host.runtime);
} else {
	process.exitCode = await runPrintMode(host.runtime, { mode: "text", initialMessage: HEADLESS_OWNER_PROMPT });
}
