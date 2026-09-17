import { appendFileSync, existsSync, readFileSync } from "node:fs";

import {
	CustomEditor,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const isProcessChild = process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP !== undefined;

class AgentViewProbeEditor extends CustomEditor {
	readonly #identity: string;
	#escapeCount = 0;

	constructor(
		identity: string,
		...editorArguments: ConstructorParameters<typeof CustomEditor>
	) {
		super(...editorArguments);
		this.#identity = identity;
	}

	override render(width: number): string[] {
		return [
			`Agent editor · ${this.#identity}`,
			`Custom editor Escape count · ${this.#escapeCount}`,
			...super.render(width),
		];
	}

	override handleInput(data: string): void {
		if (data === "\x1b") {
			this.#escapeCount += 1;
			return;
		}
		super.handleInput(data);
	}
}

class FailingAgentViewEditor extends CustomEditor {
	#renderFailureArmed = false;
	#renderFailureReported = false;

	override handleInput(data: string): void {
		if (data === "x" && scenario() === "failure-input") {
			record({ kind: "failure_trigger", failureKind: "input" });
			throw new Error("deterministic real child editor failure");
		}
		if (data === "x" && scenario() === "failure-render") {
			this.#renderFailureArmed = true;
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		if (this.#renderFailureArmed) {
			if (!this.#renderFailureReported) {
				this.#renderFailureReported = true;
				record({ kind: "failure_trigger", failureKind: "render" });
			}
			throw new Error("deterministic real child render failure");
		}
		return super.render(width);
	}
}

const processAgentViewProbe: ExtensionFactory = (pi) => {
	if (!isProcessChild) return;
	const activeScenario = scenario();

	if (activeScenario === "interactive") {
		pi.registerShortcut("alt+q", {
			description: "Exercise the exact child editor shortcut path",
			handler(ctx) {
				ctx.ui.setWidget("agent-view-shortcut", [
					`Agent shortcut · ${ctx.sessionManager.getSessionId()}`,
				]);
			},
		});
		pi.registerCommand("agent-view-probe", {
			description: "Open a child-local presentation probe",
			async handler(_args, ctx) {
				await ctx.ui.custom<void>(
					(_tui, _theme, _keybindings, done) => ({
						render: () => ["Child-local extension overlay"],
						invalidate() {},
						handleInput(data) {
							if (data === "\x1b") done();
						},
					}),
					{ overlay: true },
				);
			},
		});
	}
	if (activeScenario === "independent") {
		pi.registerShortcut("alt+q", {
			description: "Mark this exact child from its native shortcut path",
			handler(ctx) {
				ctx.ui.setWidget("independent-shortcut-marker", [
					`Independent shortcut · ${ctx.sessionManager.getSessionId()}`,
				]);
			},
		});
		pi.registerCommand("mark-independent-view", {
			description: "Mark this exact child mode",
			async handler(_args, ctx) {
				ctx.ui.setWidget("independent-mode-marker", [
					`Independent widget · ${ctx.sessionManager.getSessionId()}`,
				]);
			},
		});
	}

	if (activeScenario === "dormant-command") {
		pi.registerCommand("mark-dormant-view", {
			description: "Prove the Dormant view accepts normal commands",
			async handler(_args, ctx) {
				ctx.ui.setWidget("dormant-command", ["Dormant command executed"]);
				record({ kind: "command", command: "mark-dormant-view", sessionId: ctx.sessionManager.getSessionId() });
			},
		});
	}

	if (activeScenario === "unexpected-exit") {
		pi.registerCommand("exit-agent-process", {
			description: "Terminate this exact process-backed Agent Runtime",
			handler(_args, ctx) {
				record({
					kind: "process_exit",
					sessionId: ctx.sessionManager.getSessionId(),
					exitCode: 17,
				});
				process.exit(17);
			},
		});
	}

	if (activeScenario === "dormant-command-message") {
		pi.registerCommand("wake-dormant-agent", {
			description: "Emit one user message from the Dormant command",
			async handler() {
				pi.sendUserMessage("Start the successor from a Dormant slash command.");
			},
		});
	}

	pi.on("session_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		record({
			kind: "session_start",
			sessionId,
			reason: event.reason,
			generation: process.env.PROCESS_AGENT_VIEW_GENERATION,
		});

		switch (activeScenario) {
			case "interactive":
				ctx.ui.setEditorComponent((tui, theme, keybindings) =>
					new AgentViewProbeEditor(sessionId, tui, theme, keybindings)
				);
				ctx.ui.setFooter(() => new Text(`Agent footer · ${sessionId}`, 0, 0));
				ctx.ui.setStatus("agent-view-probe", `Agent status · ${sessionId}`);
				ctx.ui.setWidget("agent-view-probe", [`Agent widget · ${sessionId}`]);
				ctx.ui.notify(`Agent notification · ${sessionId}`, "info");
				break;
			case "independent":
				ctx.ui.setFooter(() => new Text(`Independent footer · ${sessionId}`, 0, 0));
				break;
			case "failure-input":
			case "failure-render":
				ctx.ui.setEditorComponent((tui, theme, keybindings) =>
					new FailingAgentViewEditor(tui, theme, keybindings)
				);
				break;
			case "startup-modal":
				await ctx.ui.confirm("Agent startup gate", "Continue exact Run initialization?");
				break;
			case "dormant-startup-modal":
				if (!isRepeatedSessionStart(sessionId)) break;
				pi.sendUserMessage("Dormant session_start input activates this Agent runtime.");
				await ctx.ui.confirm(
					"Dormant Runtime startup",
					"Finish opening the Dormant Agent presentation?",
				);
				break;
			case "selection-startup-close":
				if (!isRepeatedSessionStart(sessionId)) break;
				record({ kind: "startup_modal", sessionId });
				await ctx.ui.custom<void>(
					async () => {
						record({ kind: "custom_factory_waiting", sessionId });
						await waitForRelease();
						return {
							render: () => ["Selection startup close gate"],
							invalidate() {},
							handleInput() {},
							dispose() {
								record({ kind: "component_dispose", sessionId });
							},
						};
					},
					{ overlay: true },
				);
				record({ kind: "session_start_after_ui", sessionId });
				ctx.ui.setWidget("late-startup-state", ["Must be cleared after startup finishes"]);
				break;
			case "unselected-startup-shutdown":
				if (!isRepeatedSessionStart(sessionId)) break;
				await ctx.ui.custom<void>(
					(_tui, _theme, _keybindings, done) => {
						record({ kind: "startup_ui", sessionId });
						void waitForRelease().then(() => done());
						return {
							render: () => ["Unselected Message startup gate"],
							invalidate() {},
							handleInput() {},
						};
					},
					{ overlay: true },
				);
				record({ kind: "session_start_after_ui", sessionId });
				break;
			case "reload-generation":
				ctx.ui.setFooter(() => new Text(
					`Factory generation · ${process.env.PROCESS_AGENT_VIEW_GENERATION} · ${sessionId}`,
					0,
					0,
				));
				break;
		}
	});

	if (activeScenario === "prompt-preflight") {
		pi.on("input", async (event, ctx) => {
			if (event.text !== "Continue after the Owner leaves this Agent view.") {
				return { action: "continue" };
			}
			record({ kind: "input_preflight_started", sessionId: ctx.sessionManager.getSessionId() });
			await waitForRelease();
			try {
				void ctx.cwd;
				record({ kind: "input_preflight_finished", staleContextError: null });
				return { action: "continue" };
			} catch (error) {
				record({
					kind: "input_preflight_finished",
					staleContextError: error instanceof Error ? error.message : String(error),
				});
				return { action: "handled" };
			}
		});
	}
	if (activeScenario === "handled-prompt-preflight") {
		pi.on("input", async (event, ctx) => {
			if (event.text !== "Handle this input before the Owner leaves.") {
				return { action: "continue" };
			}
			record({ kind: "input_preflight_started", sessionId: ctx.sessionManager.getSessionId() });
			await waitForRelease();
			record({ kind: "input_preflight_finished", staleContextError: null });
			ctx.ui.notify("Handled input completed without an Agent Run.", "info");
			return { action: "handled" };
		});
	}
	if (activeScenario === "compaction-retention") {
		pi.on("session_before_compact", async (event, ctx) => {
			record({ kind: "compaction_started", sessionId: ctx.sessionManager.getSessionId() });
			await waitForRelease();
			return {
				compaction: {
					summary: "Compaction completed while the Agent view was detached.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
		pi.on("session_compact", (_event, ctx) => {
			record({ kind: "compaction_completed", sessionId: ctx.sessionManager.getSessionId() });
		});
	}

	pi.on("session_shutdown", (event, ctx) => {
		record({
			kind: "session_shutdown",
			sessionId: ctx.sessionManager.getSessionId(),
			reason: event.reason,
		});
	});
};

function scenario(): string | undefined {
	return process.env.PROCESS_AGENT_VIEW_SCENARIO;
}

function isRepeatedSessionStart(sessionId: string): boolean {
	const evidencePath = process.env.PROCESS_AGENT_VIEW_EVIDENCE;
	if (!evidencePath) return false;
	try {
		return readFileSync(evidencePath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind?: string; sessionId?: string })
			.filter((entry) => entry.kind === "session_start" && entry.sessionId === sessionId)
			.length >= 2;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function waitForRelease(): Promise<void> {
	const releasePath = process.env.PROCESS_AGENT_VIEW_RELEASE;
	if (!releasePath) throw new Error("PROCESS_AGENT_VIEW_RELEASE is required");
	while (!existsSync(releasePath)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function record(value: Record<string, unknown>): void {
	const evidencePath = process.env.PROCESS_AGENT_VIEW_EVIDENCE;
	if (!evidencePath) return;
	appendFileSync(evidencePath, `${JSON.stringify({ ...value, pid: process.pid })}\n`, "utf8");
}

export default processAgentViewProbe;
