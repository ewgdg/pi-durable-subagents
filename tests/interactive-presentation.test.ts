import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { captureInteractivePresentation } from "../src/pi-integration/interactive-presentation.ts";

test("interactive presentation stops hidden rendering and resumes current native UI", () => {
	const lifecycle: string[] = [];
	const tui = {
		stop(options?: { preserveScreen?: boolean }) {
			lifecycle.push(`stop:${String(options?.preserveScreen)}`);
		},
		start() {
			lifecycle.push("start");
		},
		renderNow(force?: boolean) {
			lifecycle.push(`renderNow:${String(force)}`);
		},
		requestRender(force?: boolean) {
			lifecycle.push(`render:${String(force)}`);
		},
		terminal: {
			write(data: string) {
				lifecycle.push(`write:${data}`);
			},
		},
	} as unknown as TUI;
	let captureWidget: Component | undefined;
	const ui = {
		setWidget(
			_key: string,
			factory: (tui: TUI, theme: Theme) => Component,
		) {
			captureWidget = factory(tui, {} as Theme);
		},
	} as unknown as ExtensionUIContext;

	const presentation = captureInteractivePresentation(ui);

	assert.deepEqual(captureWidget?.render(80), []);
	presentation.setVisible(false);
	presentation.requestFullRender();
	presentation.setVisible(true);
	assert.deepEqual(lifecycle, [
		"stop:true",
		"start",
		"renderNow:true",
	]);
});
