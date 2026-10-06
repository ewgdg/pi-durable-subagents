import assert from "node:assert/strict";
import test from "node:test";

import { escapeTerminalControls } from "./support/terminal-safe-text.ts";

test("captured TUI output cannot change terminal state once escaped", () => {
	const tuiOutput = "\x1b[?1049h\x1b[?1000h\x1b[?1006hhello\r\n\tworld\x07\x7f\x9b2J";

	const escaped = escapeTerminalControls(tuiOutput);

	assert.equal(
		escaped,
		String.raw`\x1b[?1049h\x1b[?1000h\x1b[?1006hhello` + "\r\n\tworld" + String.raw`\x07\x7f\x9b2J`,
	);
});
