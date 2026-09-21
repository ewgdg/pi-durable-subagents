import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

import { IncompatiblePiHostError } from "./host-shape.ts";

export type InteractivePresentation = Readonly<{
	setVisible(visible: boolean): void;
	/**
	 * Keep the native editor live while this Agent must receive human keystrokes.
	 * Pi stops terminal input handling together with a hidden TUI, so a hidden Agent
	 * blocked on a Human Request would never see the keystrokes the Owner forwards
	 * into its PTY, and the Answer could never commit.
	 */
	setNativeEditorRequired(required: boolean): void;
	requestFullRender(): void;
}>;

const TUI_CAPTURE_WIDGET_KEY = "agent-coordination.interactive-tui-capture";

/** Capture Pi's stable public TUI reference without adding visible widget content. */
export function captureInteractivePresentation(
	ui: ExtensionUIContext,
): InteractivePresentation {
	let capturedTui: TUI | undefined;
	ui.setWidget(
		TUI_CAPTURE_WIDGET_KEY,
		(tui) => {
			assertInteractiveTui(tui);
			capturedTui = tui;
			return new Container();
		},
		{ placement: "aboveEditor" },
	);
	if (!capturedTui) {
		throw new IncompatiblePiHostError("ExtensionUIContext.setWidget TUI factory");
	}
	const tui = capturedTui;
	// Two independent reasons own the one native TUI: the Owner's presentation
	// request and a blocked Human Request that must keep this Agent's editor live.
	let presentationRequested = true;
	let nativeEditorRequired = false;
	let visible = true;
	const applyVisibility = () => {
		const nextVisible = presentationRequested || nativeEditorRequired;
		if (visible === nextVisible) return;
		visible = nextVisible;
		if (!visible) {
			tui.stop({ preserveScreen: true });
			return;
		}
		tui.start();
		tui.renderNow(true);
	};
	return {
		setVisible(nextVisible) {
			presentationRequested = nextVisible;
			applyVisibility();
		},
		setNativeEditorRequired(required) {
			nativeEditorRequired = required;
			applyVisibility();
		},
		requestFullRender() {
			if (visible) tui.requestRender(true);
		},
	};
}

function assertInteractiveTui(value: unknown): asserts value is TUI {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new IncompatiblePiHostError("TUI");
	}
	for (const member of ["renderNow", "requestRender", "start", "stop"] as const) {
		if (typeof (value as Record<PropertyKey, unknown>)[member] !== "function") {
			throw new IncompatiblePiHostError(`TUI.${member}`);
		}
	}
}
