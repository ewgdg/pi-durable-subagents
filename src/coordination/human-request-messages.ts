/**
 * Canonical Human Request terminal texts.
 *
 * The distinction matters durably: only a user interruption is a resolution. A
 * non-user Run fence records a matching native error result but leaves the
 * question unanswered, so retained-workflow recovery can restore its attention.
 * See `docs/human-requests.md`.
 */
export const HUMAN_REQUEST_INTERRUPTED_MESSAGE =
	"Human request interrupted before an answer was provided.";
export const HUMAN_REQUEST_FENCED_MESSAGE =
	"Human request ended because its Agent Run is no longer available.";
