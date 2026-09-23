import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	fuzzyFilter,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	excludedProvider,
	isProviderExclusionEntry,
	providerExclusionEntry,
	type ModelPolicyModel,
} from "../policy/model-exclusion.ts";

const MAXIMUM_VISIBLE_ROWS = 8;

export type { ModelPolicyModel } from "../policy/model-exclusion.ts";

export type ModelPolicyRow =
	| Readonly<{
		kind: "provider";
		provider: string;
		banned: boolean;
	}>
	| Readonly<{
		kind: "model";
		provider: string;
		modelId: string;
		name: string;
		available: boolean;
		banned: boolean;
		/** Covered by the provider entry, so only that entry can change it. */
		locked: boolean;
	}>;

export type ModelPolicySurfaceOptions = Readonly<{
	availableModels: readonly ModelPolicyModel[];
	excludedModels: readonly string[];
	/** Persists the next entries and reports the entries that are now authoritative. */
	persist(entries: readonly string[]): Promise<readonly string[]>;
}>;

/**
 * Displayed rows: every available model plus every stored entry, so a ban always
 * stays reversible. Five row states matter: provider entry, allowed model,
 * banned model, model banned through its provider entry, and a stored identity
 * the catalogue no longer offers.
 */
export function modelPolicyRows(
	models: readonly ModelPolicyModel[],
	entries: readonly string[],
): ModelPolicyRow[] {
	const providerEntries = new Set<string>();
	const exactIdentities = new Map<string, Set<string>>();
	for (const entry of entries) {
		const provider = excludedProvider(entry);
		if (isProviderExclusionEntry(entry)) {
			providerEntries.add(provider);
			continue;
		}
		const identities = exactIdentities.get(provider) ?? new Set<string>();
		identities.add(entry.slice(provider.length + 1));
		exactIdentities.set(provider, identities);
	}
	const modelsByProvider = new Map<string, ModelPolicyModel[]>();
	for (const model of models) {
		modelsByProvider.set(model.provider, [...modelsByProvider.get(model.provider) ?? [], model]);
	}
	const providers = new Set([
		...modelsByProvider.keys(),
		...providerEntries,
		...exactIdentities.keys(),
	]);

	const rows: ModelPolicyRow[] = [];
	for (const provider of [...providers].sort((left, right) => left.localeCompare(right))) {
		const providerBanned = providerEntries.has(provider);
		rows.push({ kind: "provider", provider, banned: providerBanned });
		const identities = exactIdentities.get(provider) ?? new Set<string>();
		const knowledgable = modelsByProvider.get(provider) ?? [];
		const knownIds = new Set(knowledgable.map(({ modelId }) => modelId));
		const displayModels = [
			...knowledgable.map((model) => ({ ...model, available: true })),
			...[...identities]
				.filter((modelId) => !knownIds.has(modelId))
				.map((modelId) => ({
					provider,
					modelId,
					name: "",
					available: false,
				})),
		].sort((left, right) => left.modelId.localeCompare(right.modelId));
		for (const model of displayModels) {
			rows.push({
				kind: "model",
				provider,
				modelId: model.modelId,
				name: model.name,
				available: model.available,
				banned: providerBanned || identities.has(model.modelId),
				locked: providerBanned,
			});
		}
	}
	return rows;
}

export function openModelPolicySurface(
	ui: ExtensionUIContext,
	options: ModelPolicySurfaceOptions,
): Promise<void> {
	return ui.custom<void>(
		(tui, theme, _keybindings, done) => new ModelPolicySurface(tui, theme, options, done),
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

class ModelPolicySurface implements Component, Focusable {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #options: ModelPolicySurfaceOptions;
	readonly #done: (result: void) => void;
	readonly #search = new Input({ prompt: "Search: ", placeholder: "model or provider" });
	#entries: readonly string[];
	#selectedIndex = 0;
	#status: string | undefined;
	#saving = false;
	#focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		options: ModelPolicySurfaceOptions,
		done: (result: void) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#options = options;
		this.#done = done;
		this.#entries = [...options.excludedModels];
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#search.focused = value;
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const rows = this.#rows();
		const boundedWidth = Math.max(1, Math.floor(width));
		const lines = [
			...this.#border().render(boundedWidth),
			theme.fg("accent", theme.bold("Agent spawn model policy")),
			theme.fg("muted", "Banned models cannot be used by Agent Templates or agent_spawn."),
			"",
			...this.#search.render(boundedWidth),
			"",
			...this.#renderRows(rows, boundedWidth),
			"",
			...(this.#status === undefined
				? []
				: [theme.fg("warning", truncateToWidth(this.#status, boundedWidth, ""))]),
			...this.#renderDetail(rows, boundedWidth),
			theme.fg("dim", truncateToWidth(this.#footer(rows), boundedWidth, "")),
			...this.#border().render(boundedWidth),
		];
		return lines;
	}

	invalidate(): void {
		this.#search.invalidate();
	}

	handleInput(data: string): void {
		// Each change derives from the last persisted entries, so an overlapping
		// save would overwrite the pending one; closing early would let the caller
		// act on a policy that is not yet written.
		if (this.#saving) return;
		if (matchesKey(data, Key.escape)) {
			this.#done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			void this.#toggleSelected();
			return;
		}
		if (matchesKey(data, Key.ctrl("a"))) {
			void this.#commit(this.#allowed(this.#rows()));
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			void this.#commit(this.#banned(this.#rows()));
			return;
		}
		this.#search.handleInput(data);
		this.#selectedIndex = 0;
		this.#status = undefined;
		this.#tui.requestRender();
	}

	#rows(): readonly ModelPolicyRow[] {
		const rows = modelPolicyRows(this.#options.availableModels, this.#entries);
		const query = this.#search.getValue().trim();
		if (query.length === 0) return rows;
		return fuzzyFilter(rows, query, (row) => row.kind === "provider"
			? row.provider
			: `${row.provider}/${row.modelId} ${row.name}`);
	}

	#renderRows(rows: readonly ModelPolicyRow[], width: number): string[] {
		const theme = this.#theme;
		if (rows.length === 0) return [theme.fg("muted", "No matching models")];
		const visible = Math.max(1, Math.min(
			MAXIMUM_VISIBLE_ROWS,
			(this.#tui.terminal?.rows ?? MAXIMUM_VISIBLE_ROWS + 8) - 8,
		));
		const start = Math.max(0, Math.min(
			this.#selectedIndex - Math.floor(visible / 2),
			rows.length - visible,
		));
		const end = Math.min(start + visible, rows.length);
		const lines = rows.slice(start, end).map((row, offset) => {
			const selected = start + offset === this.#selectedIndex;
			const marker = selected ? theme.fg("accent", "→ ") : "  ";
			const check = row.banned ? "  " : theme.fg("accent", "✓ ");
			const label = row.kind === "provider" ? `${row.provider}/*` : row.modelId;
			const styledLabel = row.banned ? theme.fg("dim", label) : label;
			const badge = row.kind === "provider"
				? theme.fg("muted", " [provider]")
				: row.available
					? theme.fg("muted", ` [${row.provider}]`)
					: theme.fg("muted", " [unavailable]");
			return truncateToWidth(`${marker}${check}${styledLabel}${badge}`, width, "");
		});
		if (start > 0 || end < rows.length) {
			lines.push(theme.fg("muted", `  (${this.#selectedIndex + 1}/${rows.length})`));
		}
		return lines;
	}

	#renderDetail(rows: readonly ModelPolicyRow[], width: number): string[] {
		const selected = rows[this.#selectedIndex];
		if (!selected || selected.kind === "provider" || selected.name.length === 0) return [];
		return [
			this.#theme.fg("muted", truncateToWidth(`  Model Name: ${selected.name}`, width, "")),
		];
	}

	#footer(rows: readonly ModelPolicyRow[]): string {
		const banned = rows.filter((row) => row.kind === "model" && row.banned).length;
		const unavailable = rows.filter((row) => row.kind === "model" && !row.available).length;
		return [
			"  Enter toggle · Ctrl+A allow all · Ctrl+X ban all · Esc done",
			`  ${banned} banned · ${unavailable} unavailable`,
		].join("   ");
	}

	#border(): DynamicBorder {
		return new DynamicBorder((text) => this.#theme.fg("border", text));
	}

	#moveSelection(delta: number): void {
		const rows = this.#rows();
		if (rows.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + rows.length) % rows.length;
		this.#tui.requestRender();
	}

	async #toggleSelected(): Promise<void> {
		const row = this.#rows()[this.#selectedIndex];
		if (!row) return;
		if (row.kind === "provider") {
			await this.#commit(row.banned
				? this.#entries.filter((entry) => entry !== providerExclusionEntry(row.provider))
				: [...this.#entries, providerExclusionEntry(row.provider)]);
			return;
		}
		if (row.locked) {
			this.#status = `${providerExclusionEntry(row.provider)} bans this model; toggle that provider row instead`;
			this.#tui.requestRender();
			return;
		}
		const identity = `${row.provider}/${row.modelId}`;
		await this.#commit(row.banned
			? this.#entries.filter((entry) => entry !== identity)
			: [...this.#entries, identity]);
	}

	/** Bulk allow removes the entry each visible row owns; it never invents an entry. */
	#allowed(rows: readonly ModelPolicyRow[]): readonly string[] {
		const owned = new Set(rows.flatMap((row) => row.kind === "provider"
			? [providerExclusionEntry(row.provider)]
			: [`${row.provider}/${row.modelId}`]));
		return this.#entries.filter((entry) => !owned.has(entry));
	}

	/** Bulk ban writes exact identities for visible model rows and never a provider entry. */
	#banned(rows: readonly ModelPolicyRow[]): readonly string[] {
		const additions = rows
			.filter((row): row is Extract<ModelPolicyRow, { kind: "model" }> =>
				row.kind === "model" && !row.banned && !row.locked)
			.map((row) => `${row.provider}/${row.modelId}`)
			.filter((identity) => !this.#entries.includes(identity));
		return [...this.#entries, ...additions];
	}

	async #commit(next: readonly string[]): Promise<void> {
		this.#saving = true;
		this.#status = "Saving…";
		this.#tui.requestRender();
		try {
			this.#entries = [...(await this.#options.persist(next))];
			this.#status = undefined;
		} catch (error) {
			this.#status = error instanceof Error ? error.message : String(error);
		} finally {
			this.#saving = false;
		}
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#rows().length - 1));
		this.#tui.requestRender();
	}
}
