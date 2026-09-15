import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
	ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { PI_TEST_AGENT_DIR } from "../support/pi-test-environment.ts";

export const PROCESS_RUNTIME_TEST_AGENT_DIR = PI_TEST_AGENT_DIR;

export const PROCESS_RUNTIME_TEST_PROVIDER = "process-runtime-test";
export const PROCESS_RUNTIME_TEST_MODEL = "offline-child";
export const PROCESS_RUNTIME_TEST_ALTERNATE_MODEL = "offline-child-alternate";
export const PROCESS_RUNTIME_TEST_WORKING_ZONE_MODEL = "offline-child-working-zone";
export const PROCESS_RUNTIME_TEST_RESPONSE = "PROCESS_RUNTIME_PROMPT_OK";

const faux = createFauxCore({
	api: PROCESS_RUNTIME_TEST_PROVIDER,
	provider: PROCESS_RUNTIME_TEST_PROVIDER,
	models: [
		{
			id: PROCESS_RUNTIME_TEST_MODEL,
			name: "Offline process child",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 256,
		},
		{
			id: PROCESS_RUNTIME_TEST_ALTERNATE_MODEL,
			name: "Alternate offline process child",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 256,
		},
		{
			id: PROCESS_RUNTIME_TEST_WORKING_ZONE_MODEL,
			name: "Working-zone offline process child",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Keep native safety compaction above this fixture's proactive working-zone
			// threshold so the integration test can distinguish the two policies.
			contextWindow: 400_000,
			maxTokens: 256,
		},
	],
});
const delayedResponse = async () => {
	const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_RESPONSE_DELAY_MS ?? 0);
	if (delayMilliseconds > 0) {
		await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
	}
	return fauxAssistantMessage(PROCESS_RUNTIME_TEST_RESPONSE);
};
faux.setResponses(process.env.PROCESS_RUNTIME_COORDINATION_TOOLS === "1"
	? [
		fauxAssistantMessage([
			fauxToolCall("agent_observe", { operation: "status" }, {
				id: "process-observe-call",
			}),
			fauxToolCall("agent_observe", {
				operation: "search",
				scope: "direct_children",
				query: "remote",
				limit: 20,
			}, {
				id: "process-search-call",
			}),
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgent: "process-target-agent",
				content: "Exact process message",
			}, { id: "process-message-call" }),
		], { stopReason: "toolUse" }),
		delayedResponse,
	]
	: Array.from({ length: 24 }, () => delayedResponse));

const processRuntimeChildFixture: ExtensionFactory = (pi) => {
	let queuedPostRunContinuation = false;
	const visibilityProbe = process.env.PROCESS_RUNTIME_VISIBILITY_PROBE;
	let visibilityTurn = 0;
	if (visibilityProbe) {
		pi.on("session_start", () => appendFileSync(visibilityProbe, "session_start\n"));
		pi.on("agent_end", (_event, ctx) => {
			visibilityTurn++;
			ctx.ui.setEditorText("VISIBILITY_EDITOR_" + visibilityTurn);
			ctx.ui.setWidget("visibility-probe", () => ({
				render() {
					appendFileSync(visibilityProbe, "render\n");
					return ["VISIBILITY_WIDGET_" + visibilityTurn];
				},
				invalidate() {},
			}));
		});
	}
	pi.registerProvider(PROCESS_RUNTIME_TEST_PROVIDER, {
		name: "Offline process runtime test",
		baseUrl: "http://127.0.0.1:1",
		api: PROCESS_RUNTIME_TEST_PROVIDER,
		apiKey: "offline-test",
		models: faux.models,
		streamSimple: faux.streamSimple,
	});

	if (process.env.PROCESS_RUNTIME_HANG_SHUTDOWN === "1") {
		pi.on("session_shutdown", () => new Promise<void>(() => undefined));
	}

	if (process.env.PROCESS_RUNTIME_WORKING_ZONE_COMPACTION === "extension") {
		pi.on("session_before_compact", async (event) => {
			if (!event.customInstructions?.includes("prospective Request")) return;
			if (event.customInstructions.includes("DECLINE_COMPACTION")) {
				return { cancel: true };
			}
			const delayMilliseconds = Number(
				process.env.PROCESS_RUNTIME_WORKING_ZONE_DELAY_MS ?? 0,
			);
			if (delayMilliseconds > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
			}
			return {
				compaction: {
					summary: "Extension-provided working-zone compaction summary.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { customInstructions: event.customInstructions },
				},
			};
		});
	}
	pi.on("agent_end", (event) => {
		if (
			queuedPostRunContinuation ||
			!JSON.stringify(event.messages).includes("PROCESS_RUNTIME_QUEUE_AFTER_AGENT_END")
		) return;
		queuedPostRunContinuation = true;
		pi.sendMessage({
			customType: "agent-coordination.queued-compaction-test",
			content: `Queued only after agent_end so Pi prepares before continuing.${
				" queued context".repeat(400)
			}`,
			display: false,
			details: {},
		}, { deliverAs: "followUp" });
	});

	pi.on("input", async (event, ctx) => {
		if (event.text === "PROCESS_RUNTIME_DELAYED_INPUT") {
			ctx.ui.setWidget("process-runtime-delayed-input", [
				"PROCESS_RUNTIME_DELAYED_INPUT_STARTED",
			]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			return { action: "continue" };
		}
		if (event.text === "PROCESS_RUNTIME_HANDLED_INPUT") {
			ctx.ui.setWidget("process-runtime-input", ["PROCESS_RUNTIME_INPUT_HANDLED"]);
			return { action: "handled" };
		}
		if (event.text === "PROCESS_RUNTIME_TRANSFORM_INPUT") {
			return { action: "transform", text: "PROCESS_RUNTIME_TRANSFORMED_INPUT" };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Test-only fault injection: the bridge receives the public readonly view,
		// while Pi owns the writable SessionManager behind that same object.
		const sessionManager = ctx.sessionManager as unknown as SessionManager;
		const appendMessage = sessionManager.appendMessage.bind(sessionManager);
		sessionManager.appendMessage = (message) => {
			if (
				message.role === "user" &&
				JSON.stringify(message.content).includes("PROCESS_RUNTIME_DROP_MESSAGE_COMMIT")
			) return "suppressed-process-runtime-test-entry";
			return appendMessage(message);
		};
		ctx.ui.setWidget("process-runtime-test", [
			"PROCESS_RUNTIME_CHILD_WIDGET",
			`PID=${process.pid}`,
			`HERDR_ENV=${String(process.env.HERDR_ENV)}`,
			`HERDR_SOCKET_PATH=${String(process.env.HERDR_SOCKET_PATH)}`,
			`HERDR_PANE_ID=${String(process.env.HERDR_PANE_ID)}`,
			`AGENT_DIR=${String(process.env.PI_CODING_AGENT_DIR)}`,
		]);
		const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_STARTUP_DELAY_MS ?? 0);
		if (delayMilliseconds > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
		}
		if (process.env.PROCESS_RUNTIME_INITIAL_TOOLS !== undefined) {
			pi.setActiveTools(JSON.parse(process.env.PROCESS_RUNTIME_INITIAL_TOOLS));
		}
	});

	pi.registerTool({
		name: "runtime_sequential_probe",
		label: "Runtime sequential probe",
		description: "Tests current process Runtime tool classification.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		executionMode: "sequential",
		async execute() {
			return {
				content: [{ type: "text", text: "runtime sequential probe" }],
				details: {},
			};
		},
	});
	pi.registerCommand("runtime-state", {
		description: "Change effective process Runtime state",
		async handler(_args, ctx) {
			await pi.setModel(faux.models[1]!);
			pi.setActiveTools([]);
			ctx.ui.setWidget("process-runtime-state", ["PROCESS_RUNTIME_STATE_CHANGED"]);
		},
	});

	pi.registerCommand("runtime-probe", {
		description: "Show process runtime PTY input and dimensions",
		async handler(args, ctx) {
			const [rows, columns] = execFileSync("stty", ["size"], {
				encoding: "utf8",
				stdio: ["inherit", "pipe", "ignore"],
			}).trim().split(/\s+/);
			ctx.ui.setWidget("process-runtime-test", [
				"PROCESS_RUNTIME_CHILD_WIDGET",
				`INPUT=${args}`,
				`SIZE=${columns}x${rows}`,
				`HERDR_ENV=${String(process.env.HERDR_ENV)}`,
				`HERDR_SOCKET_PATH=${String(process.env.HERDR_SOCKET_PATH)}`,
				`HERDR_PANE_ID=${String(process.env.HERDR_PANE_ID)}`,
			]);
		},
	});
};

export default processRuntimeChildFixture;
