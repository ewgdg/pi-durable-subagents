import {
	estimateTokens,
	shouldCompact,
	type AgentSession,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import {
	workingZonePreparationThreshold,
} from "../policy/working-zone-preparation.ts";
import { isRuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import {
	MESSAGE_DELIVERY_CUSTOM_TYPE,
} from "../protocol/message-delivery.ts";
import type { WorkingZonePreparation } from "../runtime/agent-runtime-host.ts";

/** Owns turn preparation policy beside one exact child AgentSession generation. */
export class ChildTurnCompactionGateway {
	#disposed = false;
	#activeAdmissions = 0;
	#admissionTail: Promise<void> = Promise.resolve();
	#activeDeliveryId: string | undefined;
	readonly #generationAbort = new AbortController();
	readonly #cancelledDeliveryIds = new Set<string>();
	readonly #nativeAdmissions = new Map<number, () => void>();
	readonly #session: AgentSession;
	readonly #warn: (message: string) => void;

	constructor(
		session: AgentSession,
		warn: (message: string) => void = (message) => console.warn(message),
	) {
		this.#session = session;
		this.#warn = warn;
	}

	get signal(): AbortSignal {
		return this.#generationAbort.signal;
	}

	beforeCompaction(
		event: SessionBeforeCompactEvent,
	): { cancel: true } | undefined {
		if (this.#disposed || event.reason !== "threshold") return undefined;
		if (this.#activeAdmissions > 0 || this.#session.agent.hasQueuedMessages()) {
			return undefined;
		}
		return { cancel: true };
	}

	admit<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.#admissionTail.then(async () => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			try {
				return await operation();
			} finally {
				this.#activeAdmissions -= 1;
			}
		});
		this.#admissionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	admitDelivery<T>(
		deliveryId: string,
		operation: (checkpoint: () => void) => T | Promise<T>,
	): Promise<T> {
		return this.admit(async () => {
			this.#assertDeliveryCurrent(deliveryId);
			this.#activeDeliveryId = deliveryId;
			try {
				const result = await operation(() => this.#assertDeliveryCurrent(deliveryId));
				this.#assertDeliveryCurrent(deliveryId);
				return result;
			} catch (error) {
				this.#assertDeliveryCurrent(deliveryId);
				throw error;
			} finally {
				if (this.#activeDeliveryId === deliveryId) this.#activeDeliveryId = undefined;
			}
		});
	}

	cancelDelivery(deliveryId: string): void {
		this.#cancelledDeliveryIds.add(deliveryId);
		if (this.#activeDeliveryId === deliveryId && this.#session.isCompacting) {
			this.#session.abortCompaction();
		}
	}

	shouldDiscardActiveDeliveryInput(): boolean {
		return this.#disposed ||
			(this.#activeDeliveryId !== undefined &&
				this.#cancelledDeliveryIds.has(this.#activeDeliveryId));
	}

	completeDelivery(deliveryId: string): void {
		this.#cancelledDeliveryIds.delete(deliveryId);
	}

	async reserveNativeTurn(submissionSequence: number): Promise<void> {
		if (this.#nativeAdmissions.has(submissionSequence)) {
			throw new Error(`child_native_turn_already_admitted: ${submissionSequence}`);
		}
		const release = await this.#reserveAdmission();
		this.#nativeAdmissions.set(submissionSequence, release);
	}

	completeNativeTurn(submissionSequence: number): void {
		const release = this.#nativeAdmissions.get(submissionSequence);
		if (!release) return;
		this.#nativeAdmissions.delete(submissionSequence);
		release();
	}

	async waitForCompaction(): Promise<void> {
		this.#assertCurrentGeneration();
		if (!this.#session.isCompacting) return;
		await new Promise<void>((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const finish = (settlement: () => void) => {
				unsubscribe();
				this.#generationAbort.signal.removeEventListener("abort", abort);
				settlement();
			};
			const abort = () => finish(() => reject(
				new Error("child_turn_compaction_gateway_disposed"),
			));
			unsubscribe = this.#session.subscribe((event) => {
				if (event.type === "compaction_end") finish(resolve);
			});
			this.#generationAbort.signal.addEventListener("abort", abort, { once: true });
			if (!this.#session.isCompacting) finish(resolve);
		});
		this.#assertCurrentGeneration();
	}

	async prepareIdleCustomTurn(
		workingZonePreparation?: WorkingZonePreparation,
	): Promise<void> {
		this.#assertCurrentGeneration();
		await this.waitForCompaction();
		if (!this.#session.isIdle || !this.#session.autoCompactionEnabled) return;
		const usage = this.#session.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const settings = this.#session.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;
		const nativeThresholdApplies = shouldCompact(
			usage.tokens,
			usage.contextWindow,
			settings,
		);

		if (!workingZonePreparation) {
			if (!nativeThresholdApplies) return;
			await this.#compactAtNativeThreshold();
			this.#assertCurrentGeneration();
			return;
		}

		const incomingRequestTokens = estimateTokens({
			role: "custom",
			customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
			content: JSON.stringify({
				messages: [workingZonePreparation.prospectiveRequest],
			}),
			display: true,
			timestamp: 0,
		});
		const effectiveThreshold = workingZonePreparationThreshold({
			...workingZonePreparation.intent,
			...(isRuntimeThinkingLevel(this.#session.thinkingLevel)
				? { thinking: this.#session.thinkingLevel }
				: {}),
			contextWindow: usage.contextWindow,
			incomingRequestTokens,
		});
		if (usage.tokens <= effectiveThreshold) return;

		try {
			await this.#compactForTurnPreparation(
				workingZoneCompactionInstructions(
					workingZonePreparation.prospectiveRequest.question,
				),
			);
		} catch (error) {
			if (nativeThresholdApplies) {
				if (isNoCompactionWork(error)) return;
				throw error;
			}
			this.#warn(
				`Working-Zone Preparation failed; continuing Request Delivery: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		this.#assertCurrentGeneration();
	}

	async #compactAtNativeThreshold(): Promise<void> {
		try {
			await this.#compactForTurnPreparation();
		} catch (error) {
			// Existing custom-Delivery threshold preparation treats an
			// unsummarizable branch as Pi having no native work to perform.
			if (isNoCompactionWork(error)) return;
			throw error;
		}
	}

	async #compactForTurnPreparation(customInstructions?: string): Promise<void> {
		let aborted: boolean | undefined;
		const unsubscribe = this.#session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual") {
				aborted ??= event.aborted;
			}
		});
		try {
			await this.#session.compact(customInstructions);
		} catch (error) {
			// Pi rejects every extension cancellation but reports it as aborted.
			// Extensions cancel to hand off to their own turn, and also to keep an
			// existing checkpoint after their own compaction fails. Honor Pi's
			// outcome, not error text or extension-specific intent.
			if (!aborted) throw error;
		} finally {
			unsubscribe();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generationAbort.abort();
		if (this.#activeAdmissions > 0 && this.#session.isCompacting) {
			this.#session.abortCompaction();
		}
		for (const release of this.#nativeAdmissions.values()) release();
		this.#nativeAdmissions.clear();
	}

	async #reserveAdmission(): Promise<() => void> {
		let releaseHold!: () => void;
		let resolveAcquired!: () => void;
		let rejectAcquired!: (error: unknown) => void;
		const acquired = new Promise<void>((resolve, reject) => {
			resolveAcquired = resolve;
			rejectAcquired = reject;
		});
		const hold = this.#admissionTail.then(() => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			resolveAcquired();
			return new Promise<void>((resolve) => {
				let released = false;
				releaseHold = () => {
					if (released) return;
					released = true;
					this.#activeAdmissions -= 1;
					resolve();
				};
			});
		}).catch((error: unknown) => {
			rejectAcquired(error);
			throw error;
		});
		this.#admissionTail = hold.then(
			() => undefined,
			() => undefined,
		);
		await acquired;
		return () => releaseHold();
	}

	#assertDeliveryCurrent(deliveryId: string): void {
		this.#assertCurrentGeneration();
		if (this.#cancelledDeliveryIds.has(deliveryId)) {
			throw new Error(`child_turn_admission_cancelled: ${deliveryId}`);
		}
	}

	#assertCurrentGeneration(): void {
		if (this.#disposed) {
			throw new Error("child_turn_compaction_gateway_disposed");
		}
	}
}

function isNoCompactionWork(error: unknown): boolean {
	return error instanceof Error &&
		(error.message === "Nothing to compact (session too small)" ||
			error.message === "Already compacted");
}

function workingZoneCompactionInstructions(prospectiveQuestion: string): string {
	return [
		"Use the prospective Request below only to choose which existing context to preserve.",
		"<prospective_request>",
		escapeXmlText(prospectiveQuestion),
		"</prospective_request>",
		"The Request has not committed to this transcript. Do not include or paraphrase it in the summary, and do not state or imply that this Agent received it.",
	].join("\n");
}

function escapeXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
