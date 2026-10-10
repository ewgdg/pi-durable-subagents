import { Type } from "typebox";
import { PRESET_THINKING, RUNTIME_THINKING_LEVELS } from "./runtime-configuration.ts";

export const RuntimeThinkingSchema = Type.Enum(RUNTIME_THINKING_LEVELS);

export const CandidateThinkingSchema = Type.Union([RuntimeThinkingSchema, Type.Literal(PRESET_THINKING)]);
