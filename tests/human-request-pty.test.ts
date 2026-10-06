import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { escapeTerminalControls } from "./support/terminal-safe-text.ts";

const SCRIPT = "/usr/bin/script";
const FIXTURE = fileURLToPath(
	new URL("./fixtures/human-request-native-editor-pty-fixture.ts", import.meta.url),
);

test("Human Request wraps in transcript and submits multiline Unicode through the native editor", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		await terminal.waitFor("[Ask User]");
		await terminal.waitFor("transcript-native boundary");
		await terminal.waitFor("ANSWER");
		await terminal.waitFor("Enter submits");
		await terminal.waitFor("native draft");
		terminal.write("Z");
		terminal.write("\x1b[200~\n第二行 ✅\x1b[201~");
		terminal.write("\r");
		await terminal.waitFor("[Answer]");
		assert.deepEqual(await terminal.result(), {
			answer: "native draftZ\n第二行 ✅",
		});
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
			env: {
				...process.env,
				PI_OFFLINE: "1",
				TERM: "xterm-256color",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(child);
}

class PtyFixture {
	readonly #child: ChildProcessWithoutNullStreams;
	#output = "";
	readonly #closed: Promise<void>;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		this.#closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(
					`PTY fixture exited with ${code ?? signal ?? "unknown status"}\n${escapeTerminalControls(this.#output)}`,
				));
			});
		});
		void this.#closed.catch(() => undefined);
	}

	write(value: string): void {
		this.#child.stdin.write(value);
	}

	async waitFor(value: string): Promise<void> {
		if (this.#output.includes(value)) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${escapeTerminalControls(this.#output)}`));
			}, 10_000);
			const inspect = () => {
				if (!this.#output.includes(value)) return;
				cleanup();
				resolve();
			};
			const closed = () => {
				if (this.#output.includes(value)) {
					cleanup();
					resolve();
					return;
				}
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

	async result(): Promise<{ answer: string }> {
		await this.#closed;
		const match = /__PTY_RESULT__(\{[^\r\n]+\})/.exec(this.#output);
		if (!match) throw new Error(`PTY fixture produced no result marker\n${escapeTerminalControls(this.#output)}`);
		return JSON.parse(match[1]!) as { answer: string };
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
