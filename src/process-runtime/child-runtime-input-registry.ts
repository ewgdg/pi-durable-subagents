import type {
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";

export type ChildRuntimeInputHandler = (
	event: InputEvent,
	context: ExtensionContext,
) => Promise<InputEventResult> | InputEventResult;

type ChildRuntimeInputRegistry = WeakMap<object, {
	input: ChildRuntimeInputHandler;
	completeStartup(): Promise<void>;
}>;

const CHILD_RUNTIME_INPUT_REGISTRY_KEY = "__piAgentCoordinationChildRuntimeInputs";
const globalChildRuntimeInputRegistry = globalThis as typeof globalThis & {
	[CHILD_RUNTIME_INPUT_REGISTRY_KEY]?: ChildRuntimeInputRegistry;
};

// Bridge and tail-input extensions share one process and retained AgentSession
// across /reload.
export const childRuntimeInputs = (
	globalChildRuntimeInputRegistry[CHILD_RUNTIME_INPUT_REGISTRY_KEY] ??= new WeakMap()
);
