import { appendFileSync, existsSync } from "node:fs";

import {
	CustomEditor,
	InteractiveMode,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const failureKind = process.env.PTY_AGENT_VIEW_FAILURE;
const evidencePath = process.env.PTY_AGENT_VIEW_FAILURE_EVIDENCE;
const isProcessChild = process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP !== undefined;

class FailingChildEditor extends CustomEditor {
	#renderFailureArmed = false;
	#renderFailureReported = false;

	override handleInput(data: string): void {
		if (data === "x" && failureKind === "input") {
			record({ kind: "failure_trigger", failureKind, pid: process.pid });
			throw new Error("deterministic PTY child input failure");
		}
		if (data === "x" && failureKind === "render") {
			this.#renderFailureArmed = true;
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		if (this.#renderFailureArmed) {
			if (!this.#renderFailureReported) {
				this.#renderFailureReported = true;
				record({ kind: "failure_trigger", failureKind, pid: process.pid });
			}
			throw new Error("deterministic PTY child render failure");
		}
		return super.render(width);
	}
}

const processAgentViewFailure: ExtensionFactory = (pi) => {
	if (!isProcessChild) return;
	if (failureKind === "initialization") {
		const nativeInit = InteractiveMode.prototype.init;
		let failNextInitialization = true;
		InteractiveMode.prototype.init = async function (...args) {
			await nativeInit.apply(this, args);
			if (!failNextInitialization) return;
			failNextInitialization = false;
			record({ kind: "initialization_paused", pid: process.pid });
			await waitForInitializationRelease();
			throw new Error("deterministic PTY child initialization failure");
		};
	}
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		record({ kind: "session_start", sessionId, pid: process.pid, failureKind });
		if (failureKind === "initialization") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new FailingChildEditor(tui, theme, keybindings)
		);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		record({
			kind: "session_shutdown",
			sessionId: ctx.sessionManager.getSessionId(),
			pid: process.pid,
			failureKind,
		});
	});
};

async function waitForInitializationRelease(): Promise<void> {
	const releasePath = process.env.PTY_AGENT_VIEW_FAILURE_RELEASE;
	if (!releasePath) throw new Error("PTY_AGENT_VIEW_FAILURE_RELEASE is required");
	while (!existsSync(releasePath)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function record(value: Record<string, unknown>): void {
	if (!evidencePath) return;
	appendFileSync(evidencePath, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

export default processAgentViewFailure;
