import type { AgentSession, AgentSessionServices } from "@earendil-works/pi-coding-agent";

import { bindSessionStartup } from "../pi-integration/session-startup.ts";
import { NativeSessionDriver } from "../pi-integration/native-session-driver.ts";
import type {
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	CommitModeratorReminderIfCurrent,
	EffectiveRuntimeSnapshot,
	ModeratorReminderOutcome,
	TranscriptCommitConfirmation,
} from "./agent-runtime-host.ts";
import type { HostedAgentProjection } from "./hosted-agent-projection.ts";
import type { HostedAgentRuntime, HostedRuntimeEvent } from "./hosted-agent-runtime.ts";

/** The Owner's Runtime adapter: session behaviour lives in the Native Session Driver. */
export class InProcessHostedRuntime implements HostedAgentRuntime {
	readonly #session: AgentSession;
	readonly #driver: NativeSessionDriver;
	readonly projection: HostedAgentProjection | undefined;
	readonly #inspectSnapshot: () => EffectiveRuntimeSnapshot;

	constructor(options: {
		session: AgentSession;
		projection: HostedAgentProjection | undefined;
		inspectSnapshot(): EffectiveRuntimeSnapshot;
	}) {
		this.#session = options.session;
		this.#driver = new NativeSessionDriver(options.session);
		this.projection = options.projection;
		this.#inspectSnapshot = options.inspectSnapshot;
	}

	static fromSession(options: {
		session: AgentSession;
		services: AgentSessionServices;
		projection: HostedAgentProjection | undefined;
	}): InProcessHostedRuntime {
		return new InProcessHostedRuntime({
			session: options.session,
			projection: options.projection,
			inspectSnapshot: () => inspectInProcessRuntime(options.session, options.services),
		});
	}

	snapshot(): EffectiveRuntimeSnapshot {
		return this.#inspectSnapshot();
	}

	synchronizeState(): Promise<void> {
		return Promise.resolve();
	}

	workState(): AgentRuntimeWorkState {
		return this.#driver.isIdle() ? "settled" : "active";
	}

	hasPendingActivity(): boolean {
		return this.#driver.hasPendingActivity();
	}

	isCompacting(): boolean {
		return this.#driver.isCompacting();
	}

	queuedInputCount(): number {
		return this.#driver.queuedInputCount();
	}

	cancellationSignal(): AbortSignal {
		return this.#driver.cancellationSignal();
	}

	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch {
		// A forwarded native input hands its exact preparing submission over before
		// the driver submits it again; no await separates the two.
		if (delivery.kind === "user" && delivery.forwardedInput) {
			bindSessionStartup(this.#session).captureInputHandoff()?.();
		}
		const dispatch = this.#driver.deliver(delivery, {
			proveCommit: confirmation !== undefined,
			...(confirmation?.userCommitText === undefined ? {} : { userCommitText: confirmation.userCommitText }),
		});
		if (!confirmation) return { completion: dispatch.completion };
		return {
			completion: dispatch.completion,
			transcriptCommit: dispatch.transcriptCommit!.then(committed =>
				committed && (confirmation.inspectCommit?.() ?? true)),
		};
	}

	deliverModeratorReminder(_commitIfCurrent: CommitModeratorReminderIfCurrent): Promise<ModeratorReminderOutcome> {
		// Moderators always run as child processes, whose binding owns the reminder.
		return Promise.reject(new Error("owner_runtime_hosts_no_moderator: the Owner Runtime hosts no Moderator"));
	}

	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void {
		return this.#driver.subscribe(event => {
			switch (event.type) {
				case "run_started":
				case "compaction_changed":
				case "state_changed":
					return handler({ type: "state_changed" });
				case "run_ended": {
					const { type: _type, ...runEnd } = event;
					return handler({ type: "agent_end", ...runEnd });
				}
				case "run_settled":
					return handler({ type: "agent_settled" });
			}
		});
	}

	async clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>> {
		return this.#driver.clearQueue();
	}

	abort(): Promise<void> {
		return this.#driver.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#driver.waitForIdle();
	}

	async dispose(): Promise<void> {
		this.#driver.dispose();
		await this.#session.dispose();
	}
}

function inspectInProcessRuntime(
	session: AgentSession,
	services: AgentSessionServices,
): EffectiveRuntimeSnapshot {
	const model = session.model;
	if (!model) throw new Error("Agent Runtime model is unavailable");
	return {
		cwd: services.cwd,
		model: { provider: model.provider, modelId: model.id },
		thinking: session.thinkingLevel,
		tools: [...session.getActiveToolNames()],
		skills: services.resourceLoader.getSkills().skills.map(({ name }) => name),
		skillSources: services.resourceLoader.getSkills().skills.map(({ name, filePath }) => ({
			name,
			filePath,
		})),
		fileExtensionPaths: services.resourceLoader
			.getExtensions()
			.extensions.map(({ resolvedPath }) => resolvedPath),
		projectTrusted: services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionManager.getSessionId(),
	};
}
