/**
 * Normalization shared by every coordination body, collapsed or expanded.
 *
 * Line endings are unified and leading/trailing blank lines are dropped, so
 * expanding a block never inserts or removes a row around its body. Only whole
 * blank lines are removed: indentation inside the body is Markdown structure and
 * must survive, which a plain `trim()` would destroy.
 */
export function normalizedBody(body: string): string {
	const lines = body.replaceAll(/\r\n?/g, "\n").split("\n");
	const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
	if (firstContentLine === -1) return "";
	const lastContentLine = lines.findLastIndex((line) => line.trim().length > 0);
	return lines.slice(firstContentLine, lastContentLine + 1).join("\n");
}
