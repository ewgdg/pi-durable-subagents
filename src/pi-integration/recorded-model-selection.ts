/**
 * An Agent's model selection lives in its own session, like any Pi session: the
 * last `model_change` and `thinking_level_change` on the active branch. Preset
 * thinking is Virtual Model router state, which Pi stores on the same branch.
 * Spawn configuration only supplies the first recorded values.
 */
import {
	VIRTUAL_MODEL_STATE_ENTRY,
	type SessionEntry,
	type SessionManager,
	type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";

import { isVirtualModel } from "../policy/virtual-models.ts";
import {
	isRuntimeThinkingLevel,
	type ModelReference,
	type RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type RecordedModelSelection = Readonly<{
	model: ModelReference;
	/** Absent while Pi's default applies: a Moderator records no level before its first start. */
	thinking?: RuntimeThinkingLevel;
	/** A Virtual Model selection that routes each entry on its own level. */
	presetThinking?: true;
}>;

type ThinkingMode = "preset" | "explicit";
type ThinkingModeState = Readonly<{ thinking: ThinkingMode }>;

type SelectionRecorder = Pick<
	SessionManager,
	"appendModelChange" | "appendThinkingLevelChange" | "appendCustomEntry"
>;

/** Undefined when the branch records no model, so the initial values still apply. */
export function readRecordedModelSelection(
	branch: readonly SessionEntry[],
): RecordedModelSelection | undefined {
	const modelChange = branch.findLast((entry) => entry.type === "model_change");
	if (!modelChange) return undefined;
	const model = { provider: modelChange.provider, modelId: modelChange.modelId };
	// A level this package does not know (a newer Pi, a hand edit) is unusable like an
	// unavailable model: an ordinary Agent then falls back to its initial values.
	const recordedThinking = branch.findLast((entry) => entry.type === "thinking_level_change")?.thinkingLevel;
	const thinking = isRuntimeThinkingLevel(recordedThinking) ? recordedThinking : undefined;
	return {
		model,
		...(thinking === undefined ? {} : { thinking }),
		...(isPresetThinking(branch, model) ? { presetThinking: true } : {}),
	};
}

/** Preset mode lasts until a manual thinking change records explicit mode. */
export function isPresetThinking(
	branch: readonly SessionEntry[],
	model: ModelReference,
): boolean {
	if (!isVirtualModel(model)) return false;
	const state = branch.findLast((entry) => {
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) return false;
		const data = entry.data as Partial<VirtualModelStateData> | undefined;
		return data?.provider === model.provider && data.modelId === model.modelId;
	});
	const data = state?.type === "custom" ? state.data as VirtualModelStateData<Partial<ThinkingModeState>> : undefined;
	return data?.state?.thinking === "preset";
}

export function thinkingModeState(
	model: ModelReference,
	mode: ThinkingMode,
): VirtualModelStateData<ThinkingModeState> {
	return { provider: model.provider, modelId: model.modelId, state: { thinking: mode } };
}

export function recordModelSelection(
	session: SelectionRecorder,
	selection: RecordedModelSelection,
): void {
	session.appendModelChange(selection.model.provider, selection.model.modelId);
	if (selection.thinking !== undefined) session.appendThinkingLevelChange(selection.thinking);
	// A Virtual Model always records its mode, so an earlier preset state for the
	// same name never resumes after a fallback re-selects it explicitly.
	if (isVirtualModel(selection.model)) {
		session.appendCustomEntry(
			VIRTUAL_MODEL_STATE_ENTRY,
			thinkingModeState(selection.model, selection.presetThinking ? "preset" : "explicit"),
		);
	}
}

export function sameModelSelection(
	left: RecordedModelSelection | undefined,
	right: RecordedModelSelection,
): boolean {
	return left !== undefined &&
		left.model.provider === right.model.provider &&
		left.model.modelId === right.model.modelId &&
		left.thinking === right.thinking &&
		(left.presetThinking ?? false) === (right.presetThinking ?? false);
}
