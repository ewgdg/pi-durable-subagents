import { appendFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const STARTUP_PROBE_ENVIRONMENT = "PI_TEST_IDLE_CUSTOM_STARTUP_PROBE";
export const STARTUP_TOOL = "idle_startup_probe";
export const STARTUP_GUIDANCE = "Use idle_startup_probe to read the fixed startup marker.";
export const STARTUP_TOOL_RESULT = "IDLE_STARTUP_TOOL_EXECUTED";

// The fixture supplies the input-time setup and before-start guidance that real
// extensions need, without relying on a particular conversion extension.
const fixture: ExtensionFactory = pi => {
	let inputs = 0;
	let preparations = 0;
	const record = (event: Record<string, unknown>) => {
		const path = process.env[STARTUP_PROBE_ENVIRONMENT];
		if (!path) throw new Error("Missing idle custom startup probe path");
		appendFileSync(path, JSON.stringify(event) + "\n");
	};
	pi.on("input", event => {
		inputs++;
		record({ phase: "input", text: event.text, source: event.source });
	});
	pi.on("before_agent_start", event => {
		preparations++;
		record({ phase: "prepare", inputs, preparations });
		return {
			systemPrompt: `${event.systemPrompt}\n${STARTUP_GUIDANCE}\nStartup input ${inputs}; preparation ${preparations}.`,
		};
	});
	pi.registerTool({
		name: STARTUP_TOOL,
		label: "Startup probe",
		description: "Read a fixed harmless marker during startup tests.",
		parameters: Type.Object({}),
		async execute() {
			record({ phase: "tool" });
			return { content: [{ type: "text", text: STARTUP_TOOL_RESULT }], details: {} };
		},
	});
};

export default fixture;
