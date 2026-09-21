import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";

import type { RuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";

/**
 * A launched child clamps its thinking level to the selected model's capabilities
 * (AgentSession.setThinkingLevel delegates to this same Pi function), so the launch
 * specification must name the level the child will actually run. Delegating keeps one
 * implementation of the rule instead of restating the capability map here.
 */
export function clampThinkingToModelCapability(
	model: Model<Api>,
	level: RuntimeThinkingLevel,
): RuntimeThinkingLevel {
	return clampThinkingLevel(model, level);
}
