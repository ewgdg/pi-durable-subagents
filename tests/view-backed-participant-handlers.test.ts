import assert from "node:assert/strict";
import test from "node:test";

import { createViewBackedParticipantHandlers } from "../src/coordination/view-backed-participant-handlers.ts";
import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";

test("view-backed coordination handlers route each intent to the participant view and return its exact receipt", async () => {
	const calls: unknown[] = [];
	const receipt = (name: string) => ({ receipt: name });
	const signal = new AbortController().signal;
	const onProgress = () => undefined;
	const commonView = {
		async refreshTranscriptFacts() { calls.push("refresh-transcript-facts"); },
		message: async (...args: unknown[]) => { calls.push(["message", ...args]); return receipt("message"); },
		wait: async (...args: unknown[]) => { calls.push(["wait", ...args]); return receipt("wait"); },
		control: async (...args: unknown[]) => { calls.push(["control", ...args]); return receipt("control"); },
		askHuman: async (...args: unknown[]) => { calls.push(["ask-human", ...args]); return receipt("ask-human"); },
		status: (agentId?: string) => { calls.push(["status", agentId]); return receipt("status"); },
		search: (input: unknown) => { calls.push(["search", input]); return receipt("search"); },
		openIncomingRequests: () => { calls.push("obligations"); return receipt("obligations"); },
		inspectRequest: (requestId: string) => { calls.push(["request", requestId]); return receipt("request"); },
	};
	const ordinaryView = {
		...commonView,
		spawn: async (...args: unknown[]) => { calls.push(["spawn", ...args]); return receipt("spawn"); },
		resumeWorkflow: async (...args: unknown[]) => { calls.push(["resume-workflow", ...args]); return receipt("resume-workflow"); },
	} as unknown as OrdinaryAgentCoordinatorView;
	const moderatorView = {
		...commonView,
		reportToUser: async (...args: unknown[]) => { calls.push(["report", ...args]); return receipt("report"); },
		moderatorControl: async (...args: unknown[]) => { calls.push(["moderator-control", ...args]); return receipt("moderator-control"); },
	} as unknown as ModeratorAgentCoordinatorView;
	const ordinary = createViewBackedParticipantHandlers("ordinary", () => ordinaryView).coordination;
	const owner = createViewBackedParticipantHandlers("owner", () => ordinaryView).coordination;
	const moderator = createViewBackedParticipantHandlers("moderator", () => moderatorView).coordination;
	const messageInput = { operation: "poll", messageId: "message-1" } as const;
	const searchInput = { operation: "search", scope: "direct_children" } as const;
	const humanInput = { question: "Proceed?" };
	const reportInput = {
		symptom: "s", suspectedDefect: "d", uncertainty: "u", recoveryActions: "a", recoveryOutcome: "o", evidence: ["e"],
	};
	const moderatorInput = { operation: "resolve", summary: "Done.", rationale: "Cleared." } as const;

	assert.deepEqual(await ordinary.message("call-message", messageInput), receipt("message"));
	assert.deepEqual(await ordinary.wait("call-wait", {}, signal, onProgress), receipt("wait"));
	assert.deepEqual(await ordinary.control("call-control", { operation: "interrupt", agentId: "child" }), receipt("control"));
	assert.deepEqual(await ordinary.observe({ operation: "status", agentId: "child" }), receipt("status"));
	assert.deepEqual(await ordinary.observe(searchInput), receipt("search"));
	assert.deepEqual(await ordinary.observe({ operation: "obligations" }), receipt("obligations"));
	assert.deepEqual(await ordinary.observe({ operation: "request", requestId: "request-1" }), receipt("request"));
	assert.deepEqual(await ordinary.spawn("call-spawn", { title: "T", request: "R" }), receipt("spawn"));
	assert.deepEqual(await ordinary.askUser("call-ask", humanInput, signal), receipt("ask-human"));
	assert.deepEqual(await owner.resumeWorkflow("call-resume"), receipt("resume-workflow"));
	assert.deepEqual(await moderator.askUser("call-moderator-ask", humanInput, signal), receipt("ask-human"));
	assert.deepEqual(await moderator.reportToUser("call-report", reportInput), receipt("report"));
	assert.deepEqual(await moderator.moderatorControl("call-moderator", moderatorInput), receipt("moderator-control"));

	assert.deepEqual(calls, [
		["message", "call-message", messageInput],
		["wait", "call-wait", {}, signal, onProgress],
		["control", "call-control", { operation: "interrupt", agentId: "child" }],
		"refresh-transcript-facts", ["status", "child"],
		"refresh-transcript-facts", ["search", searchInput],
		"refresh-transcript-facts", "obligations",
		"refresh-transcript-facts", ["request", "request-1"],
		["spawn", "call-spawn", { title: "T", request: "R" }],
		["ask-human", "call-ask", humanInput, signal],
		["resume-workflow", "call-resume"],
		["ask-human", "call-moderator-ask", humanInput, signal],
		["report", "call-report", reportInput],
		["moderator-control", "call-moderator", moderatorInput],
	]);
});

test("ordinary participant snapshot requests refresh the retained Runtime snapshot", async () => {
	const preparedSnapshot = { templates: [] };
	const refreshedSnapshot = {
		templates: [{
			name: "reloaded-template",
			systemPromptMode: "append" as const,
			loadContextFiles: true,
		}],
	};
	let refreshCount = 0;
	const view = {
		agentTemplateSnapshot: () => preparedSnapshot,
		async refreshAgentTemplateSnapshot() {
			refreshCount += 1;
			return refreshedSnapshot;
		},
	} as unknown as OrdinaryAgentCoordinatorView;
	const routed = createViewBackedParticipantHandlers("ordinary", () => view).coordination;

	assert.equal(await routed.agentTemplateSnapshot(), preparedSnapshot);
	assert.equal(refreshCount, 0);
	assert.equal(await routed.agentTemplateSnapshot(true), refreshedSnapshot);
	assert.equal(refreshCount, 1);
});
