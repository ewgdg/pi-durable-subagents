import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	SelectList,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

import { isModelExcluded, modelIdentity, type ModelPolicyModel } from "../policy/model-exclusion.ts";
import {
	VIRTUAL_MODEL_PROVIDER,
	type EntryUsability,
	type VirtualModelConfigSnapshot,
	type VirtualModelDefinitions,
	type VirtualModelEntry,
} from "../policy/virtual-models.ts";
import {
	RUNTIME_THINKING_LEVELS,
	type ModelReference,
	type RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import { isAgentTemplateName } from "../templates/agent-template-name.ts";

const MAXIMUM_NAME_COLUMNS = 20;
const MAXIMUM_ID_COLUMNS = 44;
const MAXIMUM_PICKER_ROWS = 8;
const MINIMUM_PICKER_ID_COLUMNS = 24;
/** Leaves room for the `[in list]` / `[excluded]` badge within the 80-column overlay. */
const MAXIMUM_PICKER_ID_COLUMNS = 64;
/** Rows around the picker: borders, title, search, blank lines, status, and help. */
const PICKER_CHROME_ROWS = 10;
const ENTRY_SEPARATOR = " → ";
/** A new name has no previous level to keep, so its first entry starts mid-range. */
const NEW_ENTRY_THINKING: RuntimeThinkingLevel = "medium";
const READ_ONLY_MESSAGE = "Editing is disabled while the config file is invalid.";

export type VirtualModelConfigOptions = VirtualModelConfigSnapshot & Readonly<{
	/** Writes the complete next definitions and returns what the Config tab shows now. */
	persist(definitions: VirtualModelDefinitions): Promise<VirtualModelConfigSnapshot>;
}>;

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

/** Where a picked model goes: a new name's first entry, a replaced entry, or a new last entry. */
type EntryTarget =
	| Readonly<{ kind: "new_name"; name: string }>
	| Readonly<{ kind: "replace"; name: string; index: number }>
	| Readonly<{ kind: "append"; name: string }>;

type Screen =
	| Readonly<{ kind: "list" }>
	| Readonly<{ kind: "definition"; name: string }>
	| Readonly<{ kind: "name"; renaming: string | undefined; input: Input }>
	| Readonly<{ kind: "model"; target: EntryTarget; search: Input; list: SelectList }>
	| Readonly<{ kind: "thinking"; target: EntryTarget; model: ModelReference; list: SelectList }>;

type Status = Readonly<{ tone: "dim" | "warning" | "error"; text: string }>;

/**
 * Lists, adds, edits, and deletes Virtual Models. Every completed action writes the
 * complete definitions at once, so each one leaves a valid file: a new name is
 * written with its first entry, and the last entry cannot be deleted.
 */
class VirtualModelConfigSurface implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #persist: VirtualModelConfigOptions["persist"];
	readonly #done: (result: void) => void;
	#config: VirtualModelConfigSnapshot;
	#screen: Screen = { kind: "list" };
	#listFocus = 0;
	#entryFocus = 0;
	#pendingDelete: string | undefined;
	#status: Status | undefined;
	#saving = false;
	#focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		options: VirtualModelConfigOptions,
		done: (result: void) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		const { persist, ...config } = options;
		this.#persist = persist;
		this.#config = config;
		this.#done = done;
	}

	get focused(): boolean {
		return this.#focused;
	}

	// Pi places the hardware cursor (and IME candidates) from the focused Input.
	set focused(value: boolean) {
		this.#focused = value;
		this.#syncInputFocus();
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const boundedWidth = Math.max(1, Math.floor(width));
		const line = (text: string) => truncateToWidth(text, boundedWidth, "");
		const { invalidReason } = this.#config;
		const status = this.#status;
		return [
			...this.#border().render(boundedWidth),
			line(theme.fg("accent", theme.bold(this.#title()))),
			line(theme.fg("muted", `Named model lists, usable as ${VIRTUAL_MODEL_PROVIDER}/<name>.`)),
			...(invalidReason === undefined ? [] : [
				line(theme.fg("error", "The config file is invalid, so editing is disabled:")),
				line(theme.fg("error", invalidReason)),
			]),
			"",
			...this.#renderScreen(boundedWidth).map(line),
			"",
			...(status === undefined ? [] : [line(theme.fg(status.tone, status.text))]),
			line(theme.fg("dim", `  ${this.#help()}`)),
			...this.#border().render(boundedWidth),
		];
	}

	invalidate(): void {
		const screen = this.#screen;
		if (screen.kind === "name") screen.input.invalidate();
		if (screen.kind === "model") screen.search.invalidate();
	}

	handleInput(data: string): void {
		// Each edit derives from the last persisted definitions, so an overlapping save
		// would overwrite the pending one.
		if (this.#saving) return;
		this.#status = undefined;
		switch (this.#screen.kind) {
			case "list": this.#handleListInput(data); break;
			case "definition": this.#handleDefinitionInput(this.#screen, data); break;
			case "name": this.#handleNameInput(this.#screen, data); break;
			case "model": this.#handleModelInput(this.#screen, data); break;
			case "thinking": this.#handleThinkingInput(this.#screen, data); break;
		}
		this.#tui.requestRender();
	}

	// List

	#names(): readonly string[] {
		return Object.keys(this.#config.virtualModels);
	}

	#editable(): boolean {
		return this.#config.invalidReason === undefined;
	}

	/** The trailing `+ New virtual model` row exists only while editing is possible. */
	#listRowCount(): number {
		return this.#names().length + (this.#editable() ? 1 : 0);
	}

	#handleListInput(data: string): void {
		const pendingDelete = this.#pendingDelete;
		this.#pendingDelete = undefined;
		const name = this.#names()[this.#listFocus];
		if (matchesKey(data, Key.escape)) {
			if (pendingDelete === undefined) this.#done();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.#listFocus = clampIndex(this.#listFocus - 1, this.#listRowCount());
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.#listFocus = clampIndex(this.#listFocus + 1, this.#listRowCount());
		} else if (matchesKey(data, Key.enter)) {
			if (name !== undefined) this.#openDefinition(name, 0);
			else if (this.#requireEditable()) this.#openNameInput(undefined);
		} else if (matchesKey(data, "d") && name !== undefined && this.#requireEditable()) {
			if (pendingDelete === name) {
				this.#save(withoutDefinition(this.#config.virtualModels, name), () => {
					this.#listFocus = clampIndex(this.#listFocus, this.#listRowCount());
				});
			} else {
				this.#pendingDelete = name;
				this.#status = {
					tone: "warning",
					text: `Delete ${VIRTUAL_MODEL_PROVIDER}/${name}? d again to delete · Esc cancel`,
				};
			}
		}
	}

	#renderList(width: number): string[] {
		const theme = this.#theme;
		const names = this.#names();
		const nameColumns = Math.min(
			MAXIMUM_NAME_COLUMNS,
			Math.max(0, ...names.map((name) => visibleWidth(name))),
		);
		// Invalid definitions are the Owner's last valid ones, not what the file says.
		const stale = !this.#editable();
		const rows = names.map((name, index) => {
			const entries = this.#entries(name);
			const unusable = entries.filter((entry) => entryUsability(this.#config, entry.model) !== "usable").length;
			const marker = unusable > 0 ? ` [${unusable} unusable]` : "";
			const label = truncateToWidth(name, nameColumns, "…").padEnd(nameColumns);
			const summaryWidth = Math.max(0, width - 2 - nameColumns - 2 - visibleWidth(marker));
			const summary = summarizeEntries(entries, summaryWidth);
			// Pad so markers line up at the right edge across rows.
			const padding = marker ? " ".repeat(Math.max(0, summaryWidth - visibleWidth(summary))) : "";
			const body = `${label}  ${summary}${padding}`;
			const focused = index === this.#listFocus;
			const styled = stale ? theme.fg("dim", body) : focused ? theme.fg("accent", body) : body;
			return `${this.#pointer(focused)}${styled}${theme.fg("warning", marker)}`;
		});
		if (names.length === 0) rows.push(theme.fg("muted", "  No virtual models"));
		if (this.#editable()) {
			rows.push(`${this.#pointer(this.#listFocus === names.length)}${theme.fg("accent", "+ New virtual model")}`);
		}
		const focusedName = names[this.#listFocus];
		return focusedName === undefined ? rows : [...rows, "", ...this.#renderDetail(focusedName)];
	}

	#renderDetail(name: string): string[] {
		const entries = this.#entries(name);
		const theme = this.#theme;
		return [
			theme.fg("dim", `  ${VIRTUAL_MODEL_PROVIDER}/${name} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`),
			...entries.map((entry, index) =>
				theme.fg("dim", `  ${index + 1}  ${modelIdentity(entry.model)} · ${entry.thinking}`) +
					this.#usabilityMarker(entry.model)),
		];
	}

	// Definition

	#entries(name: string): readonly VirtualModelEntry[] {
		return this.#config.virtualModels[name] ?? [];
	}

	#openDefinition(name: string, entryFocus: number): void {
		this.#screen = { kind: "definition", name };
		this.#entryFocus = clampIndex(entryFocus, this.#definitionRowCount(name));
		this.#syncInputFocus();
	}

	#definitionRowCount(name: string): number {
		return this.#entries(name).length + (this.#editable() ? 1 : 0);
	}

	#handleDefinitionInput(screen: Extract<Screen, { kind: "definition" }>, data: string): void {
		const { name } = screen;
		const entries = this.#entries(name);
		const index = this.#entryFocus;
		const entry = entries[index];
		if (matchesKey(data, Key.escape)) {
			this.#screen = { kind: "list" };
			this.#listFocus = Math.max(0, this.#names().indexOf(name));
		} else if (matchesKey(data, Key.shift("k"))) {
			if (entry !== undefined && index > 0 && this.#requireEditable()) {
				this.#saveEntries(name, moveEntry(entries, index, index - 1), () => { this.#entryFocus = index - 1; });
			}
		} else if (matchesKey(data, Key.shift("j"))) {
			if (entry !== undefined && index < entries.length - 1 && this.#requireEditable()) {
				this.#saveEntries(name, moveEntry(entries, index, index + 1), () => { this.#entryFocus = index + 1; });
			}
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.#entryFocus = clampIndex(index - 1, this.#definitionRowCount(name));
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.#entryFocus = clampIndex(index + 1, this.#definitionRowCount(name));
		} else if (matchesKey(data, Key.enter)) {
			if (!this.#requireEditable()) return;
			this.#openModelPicker(entry === undefined
				? { kind: "append", name }
				: { kind: "replace", name, index });
		} else if (matchesKey(data, "a")) {
			if (this.#requireEditable()) this.#openModelPicker({ kind: "append", name });
		} else if (matchesKey(data, "r")) {
			if (this.#requireEditable()) this.#openNameInput(name);
		} else if (matchesKey(data, "d") && entry !== undefined && this.#requireEditable()) {
			if (entries.length === 1) {
				this.#status = {
					tone: "error",
					text: `A virtual model needs at least one entry. Delete ${VIRTUAL_MODEL_PROVIDER}/${name} from the list.`,
				};
				return;
			}
			this.#saveEntries(name, entries.filter((_entry, position) => position !== index), () => {
				this.#entryFocus = clampIndex(index, this.#definitionRowCount(name));
			});
		}
	}

	#renderDefinition(name: string): string[] {
		const theme = this.#theme;
		const entries = this.#entries(name);
		const idColumns = Math.min(
			MAXIMUM_ID_COLUMNS,
			Math.max(0, ...entries.map((entry) => visibleWidth(modelIdentity(entry.model)))),
		);
		const thinkingColumns = Math.max(...RUNTIME_THINKING_LEVELS.map((level) => level.length));
		const rows = entries.map((entry, index) => {
			const focused = index === this.#entryFocus;
			const id = truncateToWidth(modelIdentity(entry.model), idColumns, "…").padEnd(idColumns);
			const body = `${index + 1}  ${id}  ${entry.thinking.padEnd(thinkingColumns)}`;
			return `${this.#pointer(focused)}${focused ? theme.fg("accent", body) : body}${this.#usabilityMarker(entry.model)}`;
		});
		if (this.#editable()) {
			rows.push(`${this.#pointer(this.#entryFocus === entries.length)}${theme.fg("accent", "+ Add entry")}`);
		}
		return rows;
	}

	// Name input

	#openNameInput(renaming: string | undefined, value = renaming): void {
		const input = new Input({ prompt: `Name  ${VIRTUAL_MODEL_PROVIDER}/` });
		// Input.setValue keeps the cursor at the start; a bracketed paste of the current
		// name leaves it at the end, where a rename edits.
		if (value !== undefined) input.handleInput(`\x1b[200~${value}\x1b[201~`);
		this.#screen = { kind: "name", renaming, input };
		this.#syncInputFocus();
	}

	/** Why the typed name cannot be saved, checked on every keystroke. */
	#nameProblem(screen: Extract<Screen, { kind: "name" }>): string | undefined {
		const name = screen.input.getValue();
		if (name.length === 0) return undefined;
		if (!isAgentTemplateName(name)) return "Use lowercase letters, digits, and single hyphens, like fast-review.";
		if (name !== screen.renaming && Object.hasOwn(this.#config.virtualModels, name)) {
			return `${VIRTUAL_MODEL_PROVIDER}/${name} already exists.`;
		}
		return undefined;
	}

	#handleNameInput(screen: Extract<Screen, { kind: "name" }>, data: string): void {
		const { renaming } = screen;
		if (matchesKey(data, Key.escape)) {
			if (renaming === undefined) this.#screen = { kind: "list" };
			else this.#openDefinition(renaming, this.#entryFocus);
			this.#syncInputFocus();
			return;
		}
		if (!matchesKey(data, Key.enter)) {
			screen.input.handleInput(data);
			return;
		}
		const name = screen.input.getValue();
		if (name.length === 0 || this.#nameProblem(screen) !== undefined) return;
		if (renaming === undefined) {
			this.#openModelPicker({ kind: "new_name", name });
		} else if (name === renaming) {
			this.#openDefinition(renaming, this.#entryFocus);
		} else {
			// Users of the old name see an unavailable model, like any deleted name.
			this.#save(renameDefinition(this.#config.virtualModels, renaming, name), () => {
				this.#openDefinition(name, this.#entryFocus);
			});
		}
	}

	#renderName(screen: Extract<Screen, { kind: "name" }>, width: number): string[] {
		const problem = this.#nameProblem(screen);
		return [
			...screen.input.render(width),
			...(problem === undefined ? [] : ["", this.#theme.fg("error", problem)]),
		];
	}

	// Model picker

	/** Opens on `focus`, or on the entry being replaced. */
	#openModelPicker(target: EntryTarget, focus?: ModelReference): void {
		const search = new Input({ prompt: "Search  ", placeholder: "model or provider" });
		const current = target.kind === "replace" ? this.#entries(target.name)[target.index]?.model : undefined;
		this.#screen = { kind: "model", target, search, list: this.#modelList(target, "", focus ?? current) };
		this.#syncInputFocus();
	}

	/** Models already in the list, except the one being replaced; ids must stay unique. */
	#takenModels(target: EntryTarget): ReadonlySet<string> {
		if (target.kind === "new_name") return new Set();
		return new Set(this.#entries(target.name)
			.filter((_entry, index) => target.kind !== "replace" || index !== target.index)
			.map((entry) => modelIdentity(entry.model)));
	}

	#modelList(target: EntryTarget, query: string, focus?: ModelReference): SelectList {
		const taken = this.#takenModels(target);
		const models = [...this.#config.availableModels].sort((left, right) =>
			modelIdentity(left).localeCompare(modelIdentity(right)));
		const matches = fuzzyFilter(models, query, (model) => `${modelIdentity(model)} ${model.name}`);
		const list = new SelectList(
			matches.map((model) => ({
				value: modelIdentity(model),
				label: modelIdentity(model),
				description: this.#modelBadge(model, taken),
			})),
			this.#pickerRows(),
			this.#selectListTheme(),
			// SelectList cuts labels at 32 columns by default; model ids run longer.
			{ minPrimaryColumnWidth: MINIMUM_PICKER_ID_COLUMNS, maxPrimaryColumnWidth: MAXIMUM_PICKER_ID_COLUMNS },
		);
		if (focus !== undefined) {
			list.setSelectedIndex(Math.max(0, matches.findIndex((model) => modelIdentity(model) === modelIdentity(focus))));
		}
		return list;
	}

	#modelBadge(model: ModelPolicyModel, taken: ReadonlySet<string>): string {
		if (taken.has(modelIdentity(model))) return "[in list]";
		// Excluded models stay selectable: routing skips them per request.
		if (isModelExcluded(this.#config.excludedModels, model)) return "[excluded]";
		return "";
	}

	#handleModelInput(screen: Extract<Screen, { kind: "model" }>, data: string): void {
		const { target } = screen;
		if (matchesKey(data, Key.escape)) {
			if (target.kind === "new_name") this.#openNameInput(undefined, target.name);
			else this.#openDefinition(target.name, this.#entryFocus);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			screen.list.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = screen.list.getSelectedItem();
			if (item === null) return;
			if (this.#takenModels(target).has(item.value)) {
				this.#status = { tone: "error", text: `${item.value} is already in this list.` };
				return;
			}
			const model = this.#config.availableModels.find((candidate) => modelIdentity(candidate) === item.value)!;
			this.#openThinkingPicker(target, { provider: model.provider, modelId: model.modelId });
			return;
		}
		screen.search.handleInput(data);
		this.#screen = { ...screen, list: this.#modelList(target, screen.search.getValue()) };
	}

	// Thinking picker

	#openThinkingPicker(target: EntryTarget, model: ModelReference): void {
		const list = new SelectList(
			RUNTIME_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
			RUNTIME_THINKING_LEVELS.length,
			this.#selectListTheme(),
		);
		list.setSelectedIndex(RUNTIME_THINKING_LEVELS.indexOf(this.#initialThinking(target)));
		this.#screen = { kind: "thinking", target, model, list };
		this.#syncInputFocus();
	}

	/** Editing keeps the entry's level; a new entry starts on the previous entry's level. */
	#initialThinking(target: EntryTarget): RuntimeThinkingLevel {
		if (target.kind === "new_name") return NEW_ENTRY_THINKING;
		const entries = this.#entries(target.name);
		const entry = target.kind === "replace" ? entries[target.index] : entries.at(-1);
		return entry?.thinking ?? NEW_ENTRY_THINKING;
	}

	#handleThinkingInput(screen: Extract<Screen, { kind: "thinking" }>, data: string): void {
		const { target, model } = screen;
		if (matchesKey(data, Key.escape)) {
			this.#openModelPicker(target, model);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			screen.list.handleInput("\x1b[A");
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			screen.list.handleInput("\x1b[B");
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const thinking = screen.list.getSelectedItem()!.value as RuntimeThinkingLevel;
		const entry: VirtualModelEntry = { model, thinking };
		const entries = this.#entries(target.name);
		switch (target.kind) {
			case "new_name":
				this.#saveEntries(target.name, [entry], () => this.#openDefinition(target.name, 0));
				return;
			case "replace":
				this.#saveEntries(
					target.name,
					entries.map((current, index) => index === target.index ? entry : current),
					() => this.#openDefinition(target.name, target.index),
				);
				return;
			case "append":
				this.#saveEntries(target.name, [...entries, entry], () => {
					this.#openDefinition(target.name, entries.length);
				});
				return;
		}
	}

	// Shared

	#saveEntries(name: string, entries: readonly VirtualModelEntry[], afterSave: () => void): void {
		this.#save({ ...this.#config.virtualModels, [name]: entries }, afterSave);
	}

	/** Writes, then runs `afterSave` against the returned definitions; a failure stays on screen. */
	#save(next: VirtualModelDefinitions, afterSave: () => void): void {
		this.#saving = true;
		this.#status = { tone: "dim", text: "Saving…" };
		this.#tui.requestRender();
		void (async () => {
			try {
				this.#config = await this.#persist(next);
				this.#status = undefined;
				afterSave();
			} catch (error) {
				this.#status = {
					tone: "error",
					text: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			} finally {
				this.#saving = false;
				this.#tui.requestRender();
			}
		})();
	}

	#requireEditable(): boolean {
		if (this.#editable()) return true;
		this.#status = { tone: "error", text: READ_ONLY_MESSAGE };
		return false;
	}

	#title(): string {
		const screen = this.#screen;
		switch (screen.kind) {
			case "list": return "Virtual Models";
			case "definition": return `Virtual Models › ${screen.name}`;
			case "name": return screen.renaming === undefined
				? "Virtual Models › New"
				: `Virtual Models › ${screen.renaming} › Rename`;
			case "model": return `Virtual Models › ${screen.target.name} › ${
				screen.target.kind === "replace" ? `Entry ${screen.target.index + 1}` : "Add entry"
			}`;
			case "thinking": return `Virtual Models › ${screen.target.name} › ${modelIdentity(screen.model)}`;
		}
	}

	#help(): string {
		const screen = this.#screen;
		if (!this.#editable() && (screen.kind === "list" || screen.kind === "definition")) {
			return screen.kind === "list" ? "↑/k ↓/j · Enter open · Esc back" : "↑/k ↓/j · Esc back";
		}
		switch (screen.kind) {
			case "list": return "↑/k ↓/j · Enter open · d delete · Esc back";
			case "definition": return "Enter edit · a add · d delete · K/J move · r rename · Esc back";
			case "name": return "Enter next · Esc cancel";
			case "model": return "type to search · ↑ ↓ · Enter select · Esc back";
			case "thinking": return "↑/k ↓/j · Enter save · Esc back";
		}
	}

	#renderScreen(width: number): string[] {
		const screen = this.#screen;
		switch (screen.kind) {
			case "list": return this.#renderList(width);
			case "definition": return this.#renderDefinition(screen.name);
			case "name": return this.#renderName(screen, width);
			case "model": return [...screen.search.render(width), "", ...screen.list.render(width)];
			case "thinking": return screen.list.render(width);
		}
	}

	#syncInputFocus(): void {
		const screen = this.#screen;
		if (screen.kind === "name") screen.input.focused = this.#focused;
		if (screen.kind === "model") screen.search.focused = this.#focused;
	}

	#usabilityMarker(model: ModelReference): string {
		const usability = entryUsability(this.#config, model);
		if (usability === "usable") return "";
		return this.#theme.fg(usability === "excluded" ? "warning" : "error", ` [${usability}]`);
	}

	#pointer(focused: boolean): string {
		return focused ? this.#theme.fg("accent", "→ ") : "  ";
	}

	#pickerRows(): number {
		return Math.max(1, Math.min(MAXIMUM_PICKER_ROWS, this.#tui.terminal.rows - PICKER_CHROME_ROWS));
	}

	#selectListTheme(): SelectListTheme {
		return {
			selectedPrefix: (text) => this.#theme.fg("accent", text),
			selectedText: (text) => this.#theme.fg("accent", text),
			description: (text) => this.#theme.fg("muted", text),
			scrollInfo: (text) => this.#theme.fg("muted", text),
			noMatch: (text) => this.#theme.fg("muted", text),
		};
	}

	#border(): DynamicBorder {
		return new DynamicBorder((text) => this.#theme.fg("border", text));
	}
}

function clampIndex(index: number, count: number): number {
	return Math.max(0, Math.min(count - 1, index));
}

function moveEntry(
	entries: readonly VirtualModelEntry[],
	from: number,
	to: number,
): readonly VirtualModelEntry[] {
	const next = [...entries];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved!);
	return next;
}

function withoutDefinition(definitions: VirtualModelDefinitions, name: string): VirtualModelDefinitions {
	return Object.fromEntries(Object.entries(definitions).filter(([candidate]) => candidate !== name));
}

/** Keeps the renamed definition in its list position. */
function renameDefinition(
	definitions: VirtualModelDefinitions,
	from: string,
	to: string,
): VirtualModelDefinitions {
	return Object.fromEntries(Object.entries(definitions).map(([name, entries]) =>
		[name === from ? to : name, entries]));
}
