import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PI_TEST_ENVIRONMENT_MARKER = "PI_DURABLE_SUBAGENTS_TEST_ENVIRONMENT";

// A production Agent child also has a bootstrap marker, so only this test-owned
// marker permits descendants to reuse an inherited Pi configuration directory.
function establishPiTestAgentDirectory(): string {
	if (process.env[PI_TEST_ENVIRONMENT_MARKER] === "1") {
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		if (!inheritedAgentDir) {
			throw new Error("invalid_pi_test_environment: PI_CODING_AGENT_DIR is required");
		}
		return inheritedAgentDir;
	}

	const agentDir = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env[PI_TEST_ENVIRONMENT_MARKER] = "1";
	process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
	return agentDir;
}

export const PI_TEST_AGENT_DIR = establishPiTestAgentDirectory();
