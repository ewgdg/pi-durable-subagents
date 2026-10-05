import type { RemoteAgentSelectorSnapshot } from "../control/agent-control-protocol.ts";
import type {
	AgentActivitySnapshot,
	AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";

/** A child's Agent activity, fed by Owner selector snapshots and its own Run ends. */
export class RemoteAgentActivitySource implements AgentActivitySource {
	#agentId: string;
	readonly #handlers = new Set<() => void>();
	#selector: RemoteAgentSelectorSnapshot | undefined;
	#scopeFailed = false;

	constructor(agentId: string) {
		this.#agentId = agentId;
	}

	update(selector: RemoteAgentSelectorSnapshot): void {
		this.#agentId = selector.selectedAgentId;
		this.#selector = selector;
		this.#notifyChanged();
	}

	setScopeFailed(failed: boolean): void {
		if (this.#scopeFailed === failed) return;
		this.#scopeFailed = failed;
		this.#notifyChanged();
	}

	agentLabel(agentId: string): string | undefined {
		const selector = this.#selector;
		return selector
			? [...selector.live, ...selector.dormant]
				.find((agent) => agent.agentId === agentId)?.label
			: undefined;
	}

	selectorSnapshot(): RemoteAgentSelectorSnapshot {
		if (!this.#selector) throw new Error("child_runtime_activity_unavailable: selector snapshot is not initialized");
		return this.#selector;
	}

	snapshot(): AgentActivitySnapshot {
		const selector = this.#selector;
		if (!selector) {
			throw new Error("child_runtime_activity_unavailable: selector snapshot is not initialized");
		}
		const roster = [...selector.live, ...selector.dormant];
		const scope = roster.find(({ agentId }) => agentId === this.#agentId);
		if (!scope) {
			throw new Error(`child_runtime_activity_unavailable: Agent ${this.#agentId} is absent`);
		}
		return {
			scope: { ...scope, failed: this.#scopeFailed },
			children: selector.live
				.filter(({ directSpawnerAgentId }) => directSpawnerAgentId === this.#agentId)
				.map((child) => ({ ...child, failed: false })),
			answerMode: selector.humanAttention.some(({ agentId }) => agentId === this.#agentId),
			humanAttention: selector.humanAttention,
			operationalAttention: selector.operationalAttention,
			reports: selector.reports,
		};
	}

	addChangeHandler(handler: () => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	#notifyChanged(): void {
		for (const handler of this.#handlers) handler();
	}
}
