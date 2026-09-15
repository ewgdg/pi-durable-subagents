import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const RUNTIME_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

// Pi owns the type; this runtime list must reject both invalid and missing levels.
type AssertNever<T extends never> = T;
type MissingRuntimeThinkingLevels = AssertNever<
	Exclude<ThinkingLevel, (typeof RUNTIME_THINKING_LEVELS)[number]>
>;

export type RuntimeThinkingLevel = ThinkingLevel;

export type ModelReference = Readonly<{ provider: string; modelId: string }>;

export type InheritableRuntimeConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
}>;

const RUNTIME_THINKING_LEVEL_SET = new Set<RuntimeThinkingLevel>(RUNTIME_THINKING_LEVELS);

export function isRuntimeThinkingLevel(value: unknown): value is RuntimeThinkingLevel {
	return typeof value === "string" && RUNTIME_THINKING_LEVEL_SET.has(
		value as RuntimeThinkingLevel,
	);
}
