import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";

import { escapeTerminalControls } from "./support/terminal-safe-text.ts";

const SCRIPT = "/usr/bin/script";
const PTY_WAIT_TIMEOUT_MS = 5_000;
const BANNER_ABSENCE_POLL_ATTEMPTS = 20;
const BANNER_ABSENCE_POLL_INTERVAL_MS = 25;
const FIXTURE = fileURLToPath(
	new URL("./fixtures/detached-child-ui-pty-fixture.ts", import.meta.url),
);

test("a child's session_start notify never appears in the Owner's PTY transcript", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		// Owner session_start behavior is unchanged: its own startup banner is
		// visible before the child exists.
		await terminal.waitFor("__PTY_OWNER_BOUND__");
		const setup = await terminal.marker<{
			ownerId: string;
			childId: string;
		}>("__PTY_SETUP__");
		assert.equal(
			(await terminal.screen()).join("\n").includes(
				`__PTY_DETACHED_BANNER_${setup.ownerId}__`,
			),
			true,
		);

		// The child's session_start banner must never render: poll the visible
		// viewport (not the scrollback) across the fixture's settle window.
		for (let attempt = 0; attempt < BANNER_ABSENCE_POLL_ATTEMPTS; attempt += 1) {
			const frame = (await terminal.screen()).join("\n");
			assert.equal(
				frame.includes(`__PTY_DETACHED_BANNER_${setup.childId}__`),
				false,
			);
			await new Promise<void>((resolve) =>
				setTimeout(resolve, BANNER_ABSENCE_POLL_INTERVAL_MS)
			);
		}
		await terminal.waitFor("__PTY_DONE__");
	} finally {
		terminal.kill();
	}
});

function launchFixture() {
	const command = `${quoteShell(process.execPath)} ${quoteShell(FIXTURE)}`;
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			env: { ...process.env, PI_OFFLINE: "1", TERM: "xterm-256color" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(child);
}

class PtyFixture {
	readonly #child: ChildProcessWithoutNullStreams;
	#output = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
	}

	async screen(): Promise<string[]> {
		const terminal = new xtermHeadless.Terminal({
			allowProposedApi: true,
			cols: 80,
			rows: 24,
			scrollback: 1_000,
		});
		await new Promise<void>((resolve) => terminal.write(this.#output, resolve));
		const buffer = terminal.buffer.active;
		return Array.from({ length: 24 }, (_value, index) =>
			buffer.getLine(buffer.viewportY + index)?.translateToString(true).trim() ?? ""
		);
	}

	async marker<T>(prefix: string): Promise<T> {
		await this.waitFor(prefix);
		const match = new RegExp(`${prefix}(\\{[^\\r\\n]+\\})`).exec(this.#output);
		if (!match) throw new Error(`PTY marker ${prefix} has no JSON payload`);
		return JSON.parse(match[1]!) as T;
	}

	async waitFor(value: string): Promise<void> {
		if (this.#output.includes(value)) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${escapeTerminalControls(this.#output)}`));
			}, PTY_WAIT_TIMEOUT_MS);
			const inspect = () => {
				if (!this.#output.includes(value)) return;
				cleanup();
				resolve();
			};
			const closed = () => {
				cleanup();
				reject(new Error(
					`PTY fixture closed before ${JSON.stringify(value)} appeared\n${escapeTerminalControls(this.#output)}`,
				));
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
		});
	}

	kill(): void {
		if (this.#child.exitCode === null && this.#child.signalCode === null) {
			this.#child.kill("SIGTERM");
		}
	}
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
