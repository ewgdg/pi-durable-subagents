import type { HostedAgentProjection } from "../runtime/hosted-agent-projection.ts";
import {
	createAdmittedPiChildProcessProjection,
	type AdmittedPiChildProjectionRuntime,
} from "./admitted-pi-child-process-projection.ts";
import { TerminalInputSubmissionTracker } from "./terminal-input-submission-tracker.ts";

export type PiChildProjectionLaunch = AdmittedPiChildProjectionRuntime & Readonly<{
	ready(): Promise<unknown>;
	cancelInitialization(error: unknown): Promise<void> | undefined;
}>;

/**
 * Project one live child launch before and after exact Runtime admission.
 * Child input-idle follows explicit interactive lifecycle events. PTY dispatch
 * remains byte-transparent, so embedded newlines in bracketed paste cannot be
 * mistaken for submission. Keeping the edge here lets Runtime release wait
 * without exposing PTY or Control details above the projection boundary.
 */
export function createPiChildProcessProjection(
	launch: PiChildProjectionLaunch,
): HostedAgentProjection {
	const terminal = createAdmittedPiChildProcessProjection(launch);
	const inputSubmissions = new TerminalInputSubmissionTracker();
	const readiness = launch.ready().then(() => undefined);
	void readiness.catch(() => undefined);
	let processingInput = false;
	let inputIdle = Promise.resolve();
	let settleInputIdle: (() => void) | undefined;
	let childInputActive = false;
	let latestSubmissionSequence = 0;
	let acknowledgedSubmissionSequence = 0;
	let activeSubmissionSequence: number | undefined;
	let fencedThroughSubmissionSequence = 0;
	let disposed = false;
	const hasPendingSubmission = () => acknowledgedSubmissionSequence < latestSubmissionSequence;
	const finishInput = (submissionSequence = activeSubmissionSequence) => {
		if (
			submissionSequence !== undefined &&
			activeSubmissionSequence !== submissionSequence
		) return;
		childInputActive = false;
		activeSubmissionSequence = undefined;
		processingInput = hasPendingSubmission();
		if (processingInput) return;
		const settle = settleInputIdle;
		settleInputIdle = undefined;
		settle?.();
	};
	const removeRuntimeEventHandler = launch.onEvent((event) => {
		if (disposed) return;
		if (event.event === "runtime.input.submissionAcknowledged") {
			acknowledgedSubmissionSequence = Math.max(
				acknowledgedSubmissionSequence,
				event.payload.sequence,
			);
			if (!childInputActive && !hasPendingSubmission()) finishInput();
			return;
		}
		if (event.event === "runtime.input.started") {
			childInputActive = true;
			activeSubmissionSequence = event.payload.sequence;
			latestSubmissionSequence = Math.max(
				latestSubmissionSequence,
				event.payload.sequence,
			);
			processingInput = true;
			if (!settleInputIdle) {
				inputIdle = new Promise<void>((resolve) => {
					settleInputIdle = resolve;
				});
			}
			return;
		}
		if (event.event === "runtime.input.completed") {
			finishInput(event.payload.sequence);
			return;
		}
		if (childInputActive && event.event === "agent.start") finishInput();
	});

	return Object.freeze({
		presentation: terminal.presentation,
		screenView: terminal.screenView,
		physicalTerminal: terminal.physicalTerminal,
		resize: terminal.resize,
		dispatchInput(data) {
			const previousSubmissionSequence = latestSubmissionSequence;
			latestSubmissionSequence = inputSubmissions.observe(data);
			if (latestSubmissionSequence > previousSubmissionSequence) processingInput = true;
			if (processingInput && !settleInputIdle) {
				inputIdle = new Promise<void>((resolve) => {
					settleInputIdle = resolve;
				});
			}
			terminal.dispatchInput(data);
		},
		focusEditor: terminal.focusEditor,
		addChangeHandler: terminal.addChangeHandler,
		addFailureHandler: terminal.addFailureHandler,
		addExitRequestHandler: terminal.addExitRequestHandler,
		isProcessingInput: () => processingInput,
		fenceInputSubmissions() {
			fencedThroughSubmissionSequence = Math.max(
				fencedThroughSubmissionSequence,
				latestSubmissionSequence,
			);
		},
		inputSubmissionIsFenced: (sequence) =>
			sequence <= fencedThroughSubmissionSequence,
		whenInputIdle: () => inputIdle,
		ready: () => readiness,
		cancelInitialization: (error) => launch.cancelInitialization(error),
		dispose: async () => {
			disposed = true;
			removeRuntimeEventHandler();
			inputSubmissions.dispose();
			acknowledgedSubmissionSequence = latestSubmissionSequence;
			finishInput();
			await terminal.dispose();
		},
	});
}
