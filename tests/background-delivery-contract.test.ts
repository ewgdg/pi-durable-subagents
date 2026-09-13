import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { validateAgentMessageInput, sameAgentMessageInput } from "../src/protocol/agent-message-input.ts";
import { agentControlMethods } from "../src/control/agent-control-protocol.ts";
import { renderAgentMessageCall } from "../src/tools/message-renderer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
for (const input of [
	{ operation: "send", targetAgent: "recipient", content: "Optional note", deliveryMode: "background" },
	{ operation: "request", targetAgent: "recipient", title: "Optional task", question: "Do this later", deliveryMode: "background" },
] as const) {
	test(`Background ${input.operation} input is explicit, immutable and transported`, () => {
		assert.deepEqual(validateAgentMessageInput(input), input);
		assert.ok(Check(agentControlMethods["coordination.message"].request, { toolCallId: "background", input }));
		assert.equal(sameAgentMessageInput(input, { ...input, deliveryMode: "deferred" }), false);
		const { deliveryMode: _mode, ...defaultInput } = input;
		assert.deepEqual(validateAgentMessageInput(defaultInput), defaultInput, "omission does not inherit Background");
		assert.equal(sameAgentMessageInput(defaultInput, { ...input, deliveryMode: "deferred" }), true);
		assert.throws(() => validateAgentMessageInput({ ...input, deliveryMode: "low" }), /invalid_input/);
		assert.throws(() => validateAgentMessageInput({ operation: "retry", messageId: "original", deliveryMode: "deferred" }), /invalid_input/);
	});
	test(`Background ${input.operation} rendering identifies its delivery policy`, () => {
		assert.match(renderAgentMessageCall(input, theme).render(160).join("\n"), /background/);
	});
}
