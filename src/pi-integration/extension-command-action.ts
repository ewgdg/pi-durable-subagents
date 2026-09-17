import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Build the host action that runs one extension command exactly as the human
 * would by submitting it from the editor. Pi resolves extension commands before
 * its streaming checks, so the action also works while the Agent is mid-turn.
 *
 * `command` must include the leading slash and name a command registered in this
 * session. Pi sends unrecognized slash text as an ordinary user prompt, so only
 * wire this to a session that owns the command.
 */
export function extensionCommandAction(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	command: string,
): () => void {
	return () => pi.sendUserMessage(command, { expandPromptTemplates: true });
}
