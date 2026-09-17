import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RepairArchiveLaunch } from "../repair/repair-launch.ts";
import { sanitizeReportTerminalText } from "./moderator-report-surface.ts";

const MAX_VISIBLE_EVIDENCE_CHARACTERS = 200_000;

/** Inspection never resumes a participant or grants write/application authority. */
export async function openRepairDiagnostics(ui: ExtensionUIContext, launch: RepairArchiveLaunch, directory: string, options: {
	page?: number; signal?: AbortSignal;
} = {}): Promise<void> {
	const storageDirectory = join(launch.storageRoot, launch.attemptId);
	const seals = await readdir(join(storageDirectory, "seals")).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return []; throw error;
	});
	const sources = [
		{ label: "Progress", path: join(directory, "events.jsonl") },
		{ label: "Owner snapshot", path: join(storageDirectory, "snapshot", "file-0") },
		{ label: "Repair Moderator", path: join(directory, "moderator.jsonl") },
		...(seals.at(-1) ? [{ label: "Validation audit", path: join(storageDirectory, "seals", seals.at(-1)!, "report.txt") }] : []),
	];
	const readPage = async (source: { label: string; path: string }) => {
		const contents = await readFile(source.path, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "Not recorded. No snapshot or proposal is implied."; throw error;
		});
		const bounded = contents.length > MAX_VISIBLE_EVIDENCE_CHARACTERS
			? `[Showing last ${MAX_VISIBLE_EVIDENCE_CHARACTERS} characters. Full evidence remains at the path above.]\n${contents.slice(-MAX_VISIBLE_EVIDENCE_CHARACTERS)}` : contents;
		return { ...source, contents: sanitizeReportTerminalText(bounded) };
	};
	const pages = await Promise.all(sources.map(readPage));
	let removeAbort = () => {};
	if (options.signal?.aborted) return;
	try { await ui.custom<void>((tui, theme, _keys, done) => {
		let page = Math.min(options.page ?? 0, pages.length - 1);
		let top = 0;
		let maximumTop = 0;
		const contents = () => pages[page].contents;
		const body = new Text(contents(), 0, 0);
		const close = () => done();
		options.signal?.addEventListener("abort", close, { once: true });
		if (options.signal?.aborted) close();
		removeAbort = () => options.signal?.removeEventListener("abort", close);
		return {
			render(width) {
				const height = Math.max(1, tui.terminal.rows);
				const rows = Math.max(0, height - 5);
				const lines = body.render(Math.max(1, width));
				maximumTop = Math.max(0, lines.length - rows);
				top = Math.max(0, Math.min(top, maximumTop));
				const linesToShow = [
					theme.fg("accent", `Repair ${launch.attemptId} · Workflow ${launch.owner.workflowId}`),
					`Moderator ${launch.moderatorAgentId} · read-only; no Runs resume`,
					pages[page].path,
					...Array.from({ length: rows }, (_, index) => lines[top + index] ?? ""),
					pages.map(({ label }, index) => `${index + 1} ${label}${page === index ? " *" : ""}`).join(" · "),
					"q/Esc close · ↑/↓/PgUp/PgDn scroll",
				];
				// Even a one-row terminal keeps a close hint without drawing offscreen.
				const fitted = height >= 5 ? linesToShow : [...linesToShow.slice(0, height - 1), linesToShow.at(-1)!];
				return fitted.map((line) => truncateToWidth(line, width, "", true));
			},
			handleInput(data) {
				if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { done(); return; }
				const selected = Number(data) - 1;
				if (Number.isInteger(selected) && selected >= 0 && selected < pages.length) { page = selected; top = 0; body.setText(contents()); }
				else if (matchesKey(data, Key.up)) top--;
				else if (matchesKey(data, Key.down)) top++;
				else if (matchesKey(data, Key.pageUp)) top -= Math.max(1, tui.terminal.rows - 5);
				else if (matchesKey(data, Key.pageDown)) top += Math.max(1, tui.terminal.rows - 5);
				else if (matchesKey(data, Key.end)) top = maximumTop;
				else return;
				top = Math.max(0, Math.min(top, maximumTop));
				tui.requestRender();
			},
			invalidate() { body.invalidate(); },
		};
	}, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
	} finally { removeAbort(); }
}
