import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { isModelExcluded } from "../policy/model-exclusion.ts";
import {
	requireVirtualModelDefinition,
	selectVirtualModelEntry,
	VIRTUAL_MODEL_PROVIDER,
	type EntryUsability,
} from "../policy/virtual-models.ts";
import {
	DEFAULT_WORKFLOW_POLICY,
	readWorkflowPolicy,
	type WorkflowPolicySnapshot,
} from "../policy/workflow-policy.ts";
import { RUNTIME_THINKING_LEVELS, type ModelReference } from "../protocol/runtime-configuration.ts";

/**
 * Registers the user's Virtual Models with Pi in one process and routes their
 * requests. Pi resolves `--model` and restores a session's model selection right
 * after extension factories run, so the first sync must finish inside the factory.
 *
 * Every routed request re-reads the policy file, so an edited entry list applies on
 * the next request in every process. Only adding or removing a name waits for the
 * next sync (a new process, or an Owner session_start).
 */
export class VirtualModelRegistrar {
	readonly #pi: ExtensionAPI;
	#agentDir: string;
	#policy: WorkflowPolicySnapshot = DEFAULT_WORKFLOW_POLICY;
	#registered = new Set<string>();
	#reportedInvalidPolicy: string | undefined;

	private constructor(pi: ExtensionAPI, agentDir: string) {
		this.#pi = pi;
		this.#agentDir = agentDir;
	}

	static async create(pi: ExtensionAPI, agentDir: string): Promise<VirtualModelRegistrar> {
		const registrar = new VirtualModelRegistrar(pi, agentDir);
		await registrar.sync(agentDir);
		return registrar;
	}

	/** Re-reads the policy and makes the registered names match its definitions. */
	async sync(agentDir: string): Promise<void> {
		this.#agentDir = agentDir;
		await this.#refreshPolicy(undefined);
		const names = new Set(Object.keys(this.#policy.virtualModels));
		for (const name of this.#registered) {
			if (!names.has(name)) this.#pi.unregisterVirtualModel(VIRTUAL_MODEL_PROVIDER, name);
		}
		for (const name of names) {
			// Registering an existing name replaces it, which is harmless here: the
			// route reads definitions at request time, not from the registration.
			this.#pi.registerVirtualModel({
				provider: VIRTUAL_MODEL_PROVIDER,
				id: name,
				name,
				// The selected level is only router input, and Pi clamps the routed level
				// to the real model. Offering every level keeps a spawn from lowering the
				// selection before the router knows which entry serves the request.
				thinkingLevels: RUNTIME_THINKING_LEVELS,
				route: (request, ctx) => this.#route(name, request, ctx),
			});
		}
		this.#registered = names;
	}

	async #route(
		name: string,
		request: ModelRouteRequest,
		ctx: ExtensionContext,
	): Promise<ModelRoute> {
		await this.#refreshPolicy(ctx);
		const { excludedModels, virtualModels } = this.#policy;
		const entries = requireVirtualModelDefinition(virtualModels, name);
		const available = ctx.modelRegistry.getAvailable();
		const usability = (model: ModelReference): EntryUsability => {
			if (isModelExcluded(excludedModels, model)) return "excluded";
			return available.some((candidate) => candidate.provider === model.provider && candidate.id === model.modelId)
				? "usable"
				: "unavailable";
		};
		const stickyModel = request.reason === "retry"
			? request.failed?.model ?? request.previous?.model
			: request.reason === "continuation" ? request.previous?.model : undefined;
		const entry = selectVirtualModelEntry({
			name,
			entries,
			usability,
			...(stickyModel === undefined ? {} : { sticky: { provider: stickyModel.provider, modelId: stickyModel.id } }),
		});
		const model = available.find((candidate) =>
			candidate.provider === entry.model.provider && candidate.id === entry.model.modelId);
		if (model === undefined) throw new Error(`Virtual model routing lost ${entry.model.provider}/${entry.model.modelId}`);
		return { model, thinkingLevel: request.thinkingLevel };
	}

	/**
	 * An invalid edit keeps the last valid definitions, like the Owner's policy reload,
	 * and is reported once per distinct problem so a typo does not fail every request.
	 */
	async #refreshPolicy(ctx: ExtensionContext | undefined): Promise<void> {
		const read = await readWorkflowPolicy(this.#agentDir);
		if (read.ok) {
			this.#policy = read.snapshot;
			this.#reportedInvalidPolicy = undefined;
			return;
		}
		const { message } = read.diagnostic;
		if (message === this.#reportedInvalidPolicy) return;
		this.#reportedInvalidPolicy = message;
		const notice = `${message}. Virtual models keep their last valid definitions.`;
		if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
		else process.stderr.write(`${notice}\n`);
	}
}
