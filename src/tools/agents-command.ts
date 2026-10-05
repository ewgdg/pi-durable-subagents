import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import type { OrdinaryAgentCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	createControlAgentsNavigation,
	createLocalAgentsNavigation,
	type ChildAgentsPresentation,
} from "../presentation/agents-navigation-adapters.ts";
import { navigateAgents, type AgentsNavigationTarget } from "../presentation/agents-navigation.ts";
import { openModelPolicySurface } from "../presentation/model-policy-surface.ts";
import { headlessOwnerDiagnostics, openOwnerDiagnostics } from "../presentation/owner-diagnostics-surface.ts";
import type { SpawnGuidanceRefresh } from "./coordination-tools.ts";

/**
 * The session role `/agents` serves. Owner modes come from the Owner Admission
 * outcome; every child and Moderator process is a participant reaching the
 * Owner over Control.
 */
export type AgentsCommandRole =
	| Readonly<{ kind: "participant"; presentation: ChildAgentsPresentation }>
	| Readonly<{
		kind: "admitted_owner";
		view: () => OrdinaryAgentCoordinatorView;
		/** Spawn guidance that `/agents models` refreshes. */
		tools: SpawnGuidanceRefresh;
	}>
	| Readonly<{ kind: "blocked_owner"; failure: OwnerRecoveryError }>;

type AgentsSubcommand = "owner" | "diagnostics" | "models";

/** Exactly the subcommands each role offers; completions and usage derive from this. */
const SUBCOMMANDS_BY_ROLE = {
	participant: ["owner"],
	admitted_owner: ["owner", "diagnostics", "models"],
	blocked_owner: ["diagnostics"],
} as const satisfies Record<AgentsCommandRole["kind"], readonly AgentsSubcommand[]>;

const HEADLESS_AGENTS_COMMAND_MESSAGE =
	"The Agents selector, Agent views, reports, and model policy need Pi's terminal UI. " +
	"Reopen this session interactively (pi --session <file>) to use them.";

export function registerAgentsCommand(pi: ExtensionAPI, role: AgentsCommandRole): void {
	const subcommands: readonly AgentsSubcommand[] = SUBCOMMANDS_BY_ROLE[role.kind];
	const usage = `Usage: /agents [${subcommands.join("|")}]`;
	const parse = (args: string): AgentsSubcommand | undefined => {
		const argument = args.trim();
		if (!argument) return undefined;
		const subcommand = subcommands.find((candidate) => candidate === argument);
		if (!subcommand) throw new Error(usage);
		return subcommand;
	};
	pi.registerCommand("agents", {
		description: role.kind === "participant"
			? "Show Agents in the current Workflow"
			: "Show Agents or inspect coordination diagnostics",
		getArgumentCompletions(prefix) {
			const matches = subcommands.filter((subcommand) => subcommand.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const subcommand = parse(args);
			const failure = role.kind === "blocked_owner" ? role.failure : undefined;
			if (subcommand === "diagnostics") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(headlessOwnerDiagnostics(failure), failure ? "error" : "info");
					return;
				}
				await openOwnerDiagnostics(ctx.ui, failure);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(HEADLESS_AGENTS_COMMAND_MESSAGE, "warning");
				return;
			}
			if (role.kind === "blocked_owner") {
				ctx.ui.notify("Subagent coordination is unavailable. Use /agents diagnostics.", "warning");
				return;
			}
			if (role.kind === "admitted_owner" && subcommand === "models") {
				await openModels(ctx, role);
				return;
			}
			await navigate(ctx, role, subcommand === "owner" ? "owner" : "selector");
		},
	});
}

function navigate(
	ctx: ExtensionCommandContext,
	role: Extract<AgentsCommandRole, { kind: "participant" | "admitted_owner" }>,
	target: AgentsNavigationTarget,
): Promise<void> {
	return role.kind === "participant"
		? navigateAgents(ctx.ui, createControlAgentsNavigation(role.presentation), target)
		: navigateAgents(ctx.ui, createLocalAgentsNavigation(role.view(), ctx), target);
}

async function openModels(
	ctx: ExtensionCommandContext,
	role: Extract<AgentsCommandRole, { kind: "admitted_owner" }>,
): Promise<void> {
	const view = role.view();
	await openModelPolicySurface(ctx.ui, {
		...view.modelPolicy(),
		persist: async (entries) => (await view.setModelExclusions(entries)).excludedModels,
	});
	// Spawn guidance is baked into the registered tool definition, so refresh
	// it rather than leaving the Owner's own prompt describing stale bans.
	role.tools.refreshSpawnGuidance(view.agentTemplateSnapshot());
}
