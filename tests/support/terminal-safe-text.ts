/** C0 and C1 controls, except tab, newline, and carriage return, which only move the cursor. */
const TERMINAL_STATE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Renders captured PTY output for a failure message. The test reporter prints
 * that message to the developer's terminal, where raw TUI output would replay
 * mouse tracking, the alternate screen, and cursor modes; visible escapes keep
 * the transcript readable without changing terminal state.
 */
export function escapeTerminalControls(output: string): string {
	return output.replace(
		TERMINAL_STATE_CONTROLS,
		(control) => `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}
