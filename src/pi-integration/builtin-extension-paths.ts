// Pi names its built-in extensions `builtin:<name>` (for example `builtin:mcp`).
// They are part of the Pi runtime, not files, and a child launched with
// --no-extensions only gets them back by loading these paths explicitly.
const BUILTIN_EXTENSION_PATH_PREFIX = "builtin:";

export function isBuiltinExtensionPath(path: string): boolean {
	return path.startsWith(BUILTIN_EXTENSION_PATH_PREFIX);
}
