import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { isRepairProposalRevocationInput } from "../src/repair/helper-entry.ts";

test("repair revocation recognizes configured submit/followup/abort but not terminal replies or paste contents", t => {
	const previous = getKeybindings();
	t.after(() => setKeybindings(previous));
	setKeybindings(new KeybindingsManager({
		"tui.input.submit": { defaultKeys: "enter" },
		"app.message.followUp": { defaultKeys: "alt+enter" },
		"app.interrupt": { defaultKeys: "escape" },
	}));
	for (const input of ["\r", "\x1b\r", "\x1b"]) assert.equal(isRepairProposalRevocationInput(input), true);
	for (const input of ["hello", "\x1b[8;24;80t", "\x1b[?1;2c", "\x1b[?1u", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b[200~paste\r\ntext\x1b[201~", "\x1b[27;1:3u"]) {
		assert.equal(isRepairProposalRevocationInput(input), false, JSON.stringify(input));
	}
	getKeybindings().setUserBindings({ "app.interrupt": "ctrl+x", "app.message.followUp": "ctrl+q" });
	assert.equal(isRepairProposalRevocationInput("\x18"), true);
	assert.equal(isRepairProposalRevocationInput("\x11"), true);
	assert.equal(isRepairProposalRevocationInput("\x1b"), false);
});
