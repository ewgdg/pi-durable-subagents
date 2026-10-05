import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { RuntimeSnapshotSchema } from "../control/agent-control-protocol.ts";
import { isBuiltinExtensionPath } from "../pi-integration/builtin-extension-paths.ts";

export type ChildRuntimeSnapshot = Static<typeof RuntimeSnapshotSchema>;

export type ChildExplicitSystemPrompt = Readonly<{
	mode: "append" | "replace";
	filePath: string;
	body: string;
}>;

/**
 * What the child was launched with, captured once by the bridge extension shell.
 * A binding reads these instead of process environment, so it can run over any
 * Pi session.
 */
export type ChildLaunchFacts = Readonly<{
	agentId: string;
	systemPrompt: ChildExplicitSystemPrompt | null;
	loadContextFiles: boolean;
	/** Canonical bridge entry path, which the snapshot never reports as an inherited extension. */
	bridgeExtensionPath: string | undefined;
}>;

/** Inspect the effective child Runtime one Owner-visible snapshot reports. */
export async function inspectChildRuntimeSnapshot(
	runtime: AgentSessionRuntime,
	launchFacts: ChildLaunchFacts,
): Promise<ChildRuntimeSnapshot> {
	const session = runtime.session;
	const extensions = await Promise.all(
		runtime.services.resourceLoader.getExtensions().extensions
			.map((extension) => extension.resolvedPath)
			.filter((path) => !path.startsWith("<inline:"))
			.map((path) => canonicalExtensionPath(path, runtime.cwd)),
	);
	const sessionPath = session.sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("child_runtime_session_path_unavailable");
	const skillSources = await Promise.all(
		runtime.services.resourceLoader.getSkills().skills.map(async ({ name, filePath }) => ({
			name,
			filePath: await canonicalFilePath(filePath, runtime.cwd),
		})),
	);
	return {
		cwd: runtime.cwd,
		model: requireModel(session.model),
		thinking: session.thinkingLevel,
		tools: session.getActiveToolNames(),
		skills: skillSources.map(({ name }) => name),
		skillSources,
		extensions: extensions.filter((path) => path !== launchFacts.bridgeExtensionPath),
		projectTrusted: runtime.services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionId,
		sessionPath,
		systemPrompt: launchFacts.systemPrompt === null ? null : { ...launchFacts.systemPrompt },
		loadContextFiles: launchFacts.loadContextFiles,
	};
}

export async function canonicalFilePath(path: string, cwd: string): Promise<string> {
	return realpath(isAbsolute(path) ? path : resolve(cwd, path));
}

/** Pi built-in extension paths name no file and are already canonical. */
function canonicalExtensionPath(path: string, cwd: string): Promise<string> | string {
	return isBuiltinExtensionPath(path) ? path : canonicalFilePath(path, cwd);
}

function requireModel(model: AgentSessionRuntime["session"]["model"]) {
	if (!model) throw new Error("child_runtime_model_unavailable: no active model");
	return { provider: model.provider, modelId: model.id };
}
