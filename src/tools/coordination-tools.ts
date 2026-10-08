import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
	ToolExposure,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

import type { WorkflowInteraction } from "../pi-integration/workflow-interaction.ts";
import type { AgentLabelResolver } from "../presentation/agent-identity.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import {
	agentSpawnEntry,
	coordinationToolCatalogue,
} from "./coordination-tool-catalogue.ts";
import { renderInFlightLabel, renderToolError } from "./coordination-renderers.ts";

export type CoordinationRole = "owner" | "ordinary" | "moderator";

/** Wording shared by every role unless a role states its own. */
export type RoleWording = string | Readonly<{ default: string } & Partial<Record<CoordinationRole, string>>>;

/** Lookups the Owner supplies so calls name Agents rather than bare IDs. */
export type CoordinationToolPresentation = Readonly<{
	resolveAgentLabel: AgentLabelResolver;
	resolveAnswerTargetAgent(toolCallId: string): string | undefined;
}>;

export type CoordinationToolCall<Params> = Readonly<{
	toolCallId: string;
	params: Params;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<unknown> | undefined;
	ctx: ExtensionToolContext;
}>;

/** Pi's render context for a tool's calls and results; Pi does not export its name. */
type RenderContext<Params extends TSchema> = Parameters<
	NonNullable<ToolDefinition<Params, unknown>["renderResult"]>
>[3];

type ResultRenderer<Details, Params extends TSchema> = (
	result: AgentToolResult<Details>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext<Params>,
	presentation: CoordinationToolPresentation,
) => Component;

/**
 * Everything specific to one coordination tool. The shared module adds what all
 * coordination tools have in common: exposure, execution mode, result encoding,
 * and the result lifecycle.
 */
export type CoordinationToolEntry<
	Name extends string,
	Roles extends readonly CoordinationRole[],
	Handlers,
	Params extends TSchema,
	Details,
> = Readonly<{
	name: Name;
	label: string;
	description: RoleWording;
	promptSnippet: RoleWording;
	/** Agent Spawn alone builds guidance from an Agent Template Catalogue Snapshot. */
	guidance?: readonly string[] | ((snapshot: AgentTemplateCatalogueSnapshot | undefined) => readonly string[]);
	parameters: Params;
	roles: Roles;
	/** A tool that waits on a human is inactive in a Headless Workflow. */
	requiresHuman?: true;
	renderShell?: "self";
	execute(handlers: Handlers, call: CoordinationToolCall<Static<Params>>): Promise<Details>;
	/** Pi's terminate hint: the result ends the current model/tool loop. */
	endsToolLoop?(params: Static<Params>, details: Details): boolean;
	renderCall(
		args: Static<Params>,
		theme: Theme,
		context: RenderContext<Params>,
		presentation: CoordinationToolPresentation,
	): Component;
	renderReceipt: ResultRenderer<Details, Params>;
	inFlight:
		| Readonly<{ pendingLabel: string }>
		| Readonly<{ renderProgress: ResultRenderer<unknown, Params> }>;
	/** Replaces the shared error rendering of a final native error. */
	renderError?(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: RenderContext<TSchema>,
	): Component;
}>;

type AnyCoordinationToolEntry = CoordinationToolEntry<string, readonly CoordinationRole[], any, TSchema, any>;
type CatalogueEntry = (typeof coordinationToolCatalogue)[number];
export type CoordinationToolName = CatalogueEntry["name"];

type EntryHandlers<Entry, Role> = Entry extends CoordinationToolEntry<
	string,
	infer Roles,
	infer Handlers,
	TSchema,
	any
>
	? Role extends Roles[number] ? Handlers : never
	: never;
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends
	(value: infer Intersection) => void ? Intersection : never;

/** The handler port a role's adapter must provide, derived from the entries' roles. */
export type CoordinationToolHandlers<Role extends CoordinationRole> = Role extends CoordinationRole
	? UnionToIntersection<EntryHandlers<CatalogueEntry, Role>>
	: never;

type SpawnRole = (typeof agentSpawnEntry)["roles"][number];

export type SpawnGuidanceRefresh = Readonly<{
	/**
	 * Re-register only Agent Spawn with guidance from this snapshot. Pi rebuilds
	 * the base system prompt from registered definitions for each next turn, so
	 * Runs started by Delivery or steer see it too; `before_agent_start` fires
	 * only for prompt input. Pi does not re-activate an already registered name,
	 * so a refresh never undoes filtering or withholding.
	 */
	refreshSpawnGuidance(snapshot: AgentTemplateCatalogueSnapshot): void;
}>;

export type CoordinationToolsHandle<Role extends CoordinationRole> = Role extends SpawnRole
	? SpawnGuidanceRefresh
	: Readonly<Record<never, never>>;

/**
 * Coordination durability resolves each call from its committed top-level
 * assistant toolCall (identities derive from agentId/entryId/toolCallId). Calls a
 * codemode script makes through `ctx.executeTool()` never enter the transcript,
 * so they could not commit; `model-only` keeps the tools declared to the model
 * but off codemode's callable set.
 */
const COORDINATION_TOOL_EXPOSURE: ToolExposure = "model-only";

const entries: readonly AnyCoordinationToolEntry[] = coordinationToolCatalogue;

const NO_PRESENTATION: CoordinationToolPresentation = {
	resolveAgentLabel: () => undefined,
	resolveAnswerTargetAgent: () => undefined,
};

/** Register every coordination tool of one role. */
export function registerCoordinationTools<Role extends CoordinationRole>(
	pi: ExtensionAPI,
	role: Role,
	handlers: CoordinationToolHandlers<Role>,
	presentation: Partial<CoordinationToolPresentation> = {},
): CoordinationToolsHandle<Role> {
	const lookups: CoordinationToolPresentation = { ...NO_PRESENTATION, ...presentation };
	const roleEntries = entriesFor(role);
	for (const entry of roleEntries) {
		pi.registerTool(toolDefinition(entry, role, handlers, lookups, undefined));
	}
	const spawn = roleEntries.find((entry) => entry.name === agentSpawnEntry.name);
	const handle: SpawnGuidanceRefresh | Record<never, never> = spawn
		? {
			refreshSpawnGuidance(snapshot: AgentTemplateCatalogueSnapshot) {
				pi.registerTool(toolDefinition(spawn, role, handlers, lookups, snapshot));
			},
		}
		: {};
	return handle as CoordinationToolsHandle<Role>;
}

/**
 * A role's coordination tools, and the subset that should be active in this
 * interaction mode. A Headless Workflow has no human to answer, so a tool that
 * waits on one would block forever; the Agent escalates through its supervisor.
 */
export function coordinationToolActivation(
	role: CoordinationRole,
	interaction: WorkflowInteraction,
): Readonly<{ roleTools: readonly CoordinationToolName[]; activeTools: readonly CoordinationToolName[] }> {
	const roleEntries = entriesFor(role);
	return {
		roleTools: roleEntries.map(({ name }) => name as CoordinationToolName),
		activeTools: roleEntries
			.filter((entry) => interaction === "terminal" || !entry.requiresHuman)
			.map(({ name }) => name as CoordinationToolName),
	};
}

function entriesFor(role: CoordinationRole): readonly AnyCoordinationToolEntry[] {
	return entries.filter((entry) => entry.roles.includes(role));
}

function toolDefinition(
	entry: AnyCoordinationToolEntry,
	role: CoordinationRole,
	handlers: unknown,
	presentation: CoordinationToolPresentation,
	snapshot: AgentTemplateCatalogueSnapshot | undefined,
): ToolDefinition {
	const guidance = typeof entry.guidance === "function" ? entry.guidance(snapshot) : entry.guidance;
	return {
		name: entry.name,
		label: entry.label,
		description: roleWording(entry.description, role),
		promptSnippet: roleWording(entry.promptSnippet, role),
		...(guidance === undefined ? {} : { promptGuidelines: [...guidance] }),
		executionMode: "sequential",
		exposure: COORDINATION_TOOL_EXPOSURE,
		parameters: entry.parameters,
		...(entry.renderShell === undefined ? {} : { renderShell: entry.renderShell }),
		renderCall: (args, theme, context) => entry.renderCall(args, theme, context, presentation),
		renderResult: (result, options, theme, context) =>
			renderResultLifecycle(entry, result, options, theme, context, presentation),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const details = await entry.execute(handlers, { toolCallId, params, signal, onUpdate, ctx });
			const result = encodeToolResult(details);
			return entry.endsToolLoop?.(params, details) ? { ...result, terminate: true } : result;
		},
	};
}

function roleWording(wording: RoleWording, role: CoordinationRole): string {
	return typeof wording === "string" ? wording : wording[role] ?? wording.default;
}

function encodeToolResult<Details>(details: Details): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}

/**
 * One order for every coordination tool: a final native error carries its
 * message in content rather than typed details, so it must win over the receipt;
 * in-flight work needs no user action, so it renders in accent.
 */
function renderResultLifecycle(
	entry: AnyCoordinationToolEntry,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext<TSchema>,
	presentation: CoordinationToolPresentation,
): Component {
	if (!options.isPartial && context.isError) {
		return entry.renderError?.(result, options, theme, context) ?? renderToolError(result, options, theme);
	}
	if (options.isPartial) {
		return "pendingLabel" in entry.inFlight
			? renderInFlightLabel(theme, entry.inFlight.pendingLabel)
			: entry.inFlight.renderProgress(result, options, theme, context, presentation);
	}
	return entry.renderReceipt(result, options, theme, context, presentation);
}
