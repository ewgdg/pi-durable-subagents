import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import { isModelExcluded, modelIdentity } from "../policy/model-exclusion.ts";
import {
	VIRTUAL_MODEL_PROVIDER,
	type EntryUsability,
	type VirtualModelConfigSnapshot,
	type VirtualModelEntry,
} from "../policy/virtual-models.ts";
import type { ModelReference } from "../protocol/runtime-configuration.ts";

const MAXIMUM_NAME_COLUMNS = 20;
const ENTRY_SEPARATOR = " → ";

export type VirtualModelConfigOptions = VirtualModelConfigSnapshot;

/** The same rule routing applies: excluded wins, then the Owner's available models. */
export function entryUsability(
	config: Pick<VirtualModelConfigSnapshot, "availableModels" | "excludedModels">,
	model: ModelReference,
): EntryUsability {
	if (isModelExcluded(config.excludedModels, model)) return "excluded";
	return config.availableModels.some((candidate) =>
		candidate.provider === model.provider && candidate.modelId === model.modelId)
		? "usable"
		: "unavailable";
}

/**
 * One list row's entries as `modelId • thinking`, in routing order. Entries that do
 * not fit collapse into a trailing `+N`; the detail lines show every full id.
 */
export function summarizeEntries(entries: readonly VirtualModelEntry[], width: number): string {
	const parts = entries.map((entry) => `${entry.model.modelId} • ${entry.thinking}`);
	for (let shown = parts.length; shown > 0; shown--) {
		const hidden = parts.length - shown;
		const text = [...parts.slice(0, shown), ...(hidden > 0 ? [`+${hidden}`] : [])].join(ENTRY_SEPARATOR);
		if (visibleWidth(text) <= width) return text;
	}
	return truncateToWidth(parts.join(ENTRY_SEPARATOR), width, "…");
}

export function openVirtualModelConfigSurface(
	ui: ExtensionUIContext,
	options: VirtualModelConfigOptions,
): Promise<void> {
	return ui.custom<void>(
		(tui, theme, _keybindings, done) => new VirtualModelConfigSurface(tui, theme, options, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 80,
				maxHeight: "90%",
				margin: { top: 1, bottom: 1 },
			},
		},
	);
}

class VirtualModelConfigSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #config: VirtualModelConfigOptions;
	readonly #done: (result: void) => void;
	#focusedIndex = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		options: VirtualModelConfigOptions,
		done: (result: void) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#config = options;
		this.#done = done;
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const boundedWidth = Math.max(1, Math.floor(width));
		const line = (text: string) => truncateToWidth(text, boundedWidth, "");
		const { invalidReason } = this.#config;
		return [
			...this.#border().render(boundedWidth),
			theme.fg("accent", theme.bold("Virtual Models")),
			line(theme.fg("muted", `Named model lists, usable as ${VIRTUAL_MODEL_PROVIDER}/<name>.`)),
			...(invalidReason === undefined ? [] : [
				line(theme.fg("error", "The config file is invalid, so editing is disabled:")),
				line(theme.fg("error", invalidReason)),
			]),
			"",
			...this.#renderRows(boundedWidth),
			"",
			...this.#renderDetail(boundedWidth),
			line(theme.fg("dim", "  ↑/k ↓/j · Esc back")),
			...this.#border().render(boundedWidth),
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.#done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#moveFocus(-1);
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#moveFocus(1);
		this.#tui.requestRender();
	}

	#names(): readonly string[] {
		return Object.keys(this.#config.virtualModels);
	}

	#moveFocus(delta: number): void {
		const count = this.#names().length;
		this.#focusedIndex = Math.max(0, Math.min(count - 1, this.#focusedIndex + delta));
	}

	#renderRows(width: number): string[] {
		const theme = this.#theme;
		const names = this.#names();
		if (names.length === 0) return [theme.fg("muted", "  No virtual models")];
		const nameColumns = Math.min(MAXIMUM_NAME_COLUMNS, Math.max(...names.map((name) => visibleWidth(name))));
		// Invalid definitions are the Owner's last valid ones, not what the file says.
		const stale = this.#config.invalidReason !== undefined;
		return names.map((name, index) => {
			const entries = this.#config.virtualModels[name]!;
			const unusable = entries.filter((entry) => entryUsability(this.#config, entry.model) !== "usable").length;
			const marker = unusable > 0 ? ` [${unusable} unusable]` : "";
			const label = truncateToWidth(name, nameColumns, "…").padEnd(nameColumns);
			const summaryWidth = Math.max(0, width - 2 - nameColumns - 2 - visibleWidth(marker));
			const summary = summarizeEntries(entries, summaryWidth);
			// Pad so markers line up at the right edge across rows.
			const padding = marker ? " ".repeat(Math.max(0, summaryWidth - visibleWidth(summary))) : "";
			const focused = index === this.#focusedIndex;
			const prefix = focused ? theme.fg("accent", "→ ") : "  ";
			const body = `${label}  ${summary}${padding}`;
			const styled = stale ? theme.fg("dim", body) : focused ? theme.fg("accent", body) : body;
			return truncateToWidth(`${prefix}${styled}${theme.fg("warning", marker)}`, width, "");
		});
	}

	#renderDetail(width: number): string[] {
		const name = this.#names()[this.#focusedIndex];
		if (name === undefined) return [];
		const entries = this.#config.virtualModels[name]!;
		const theme = this.#theme;
		return [
			theme.fg("dim", truncateToWidth(
				`  ${VIRTUAL_MODEL_PROVIDER}/${name} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
				width,
				"",
			)),
			...entries.map((entry, index) => {
				const usability = entryUsability(this.#config, entry.model);
				const marker = usability === "usable" ? "" : ` [${usability}]`;
				return truncateToWidth(
					theme.fg("dim", `  ${index + 1}  ${modelIdentity(entry.model)} · ${entry.thinking}`) +
						theme.fg(usability === "excluded" ? "warning" : "error", marker),
					width,
					"",
				);
			}),
			"",
		];
	}

	#border(): DynamicBorder {
		return new DynamicBorder((text) => this.#theme.fg("border", text));
	}
}
