import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import { normalizedBody } from "./body-text.ts";

// Match Pi's built-in read preview so coordination messages expose a useful
// amount of context without requiring expansion.
const COLLAPSED_BODY_LINES = 10;

/**
 * Shared collapsed body preview for coordination content.
 *
 * One bounded preview for delivered Message bodies, sent Message/Request
 * payloads, Answers, cancellation reasons, and retrieved Answer previews:
 * the body is normalized (line endings unified, framing blank lines dropped),
 * source formatting inside it is preserved, the body wraps to the supplied
 * width, and a standalone hint ellipsis marks truncation after at most
 * {@link COLLAPSED_BODY_LINES} visible body rows.
 */
export class BodyPreview implements Component {
	readonly #body: string;
	readonly #bodyColor: (content: string) => string;
	readonly #hintColor: (content: string) => string;

	constructor(
		body: string,
		bodyColor: (content: string) => string,
		hintColor: (content: string) => string,
	) {
		this.#body = body;
		this.#bodyColor = bodyColor;
		this.#hintColor = hintColor;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const formatted = normalizedBody(this.#body);
		if (formatted.length === 0) return [];
		const lines = wrapTextWithAnsi(this.#bodyColor(formatted), width);
		if (lines.length <= COLLAPSED_BODY_LINES) return lines;

		return [
			...lines.slice(0, COLLAPSED_BODY_LINES),
			this.#hintColor("…"),
		];
	}

	invalidate(): void {}
}
