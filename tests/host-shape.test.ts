import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";

import piAgentCoordination from "../src/index.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertRuntimeInstanceShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
	IncompatiblePiHostError,
} from "../src/pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";

type RuntimePrototype = {
	setRebindSession(rebindSession?: (session: hostPi.AgentSession) => Promise<void>): void;
};

test("the package declares exactly the Pi host modules imported by production", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	// 0.99.0 is the first Pi release with registerVirtualModel.
	const expectedHostPeers = {
		"@earendil-works/pi-agent-core": ">=0.99.0",
		"@earendil-works/pi-ai": ">=0.99.0",
		"@earendil-works/pi-coding-agent": ">=0.99.0",
		"@earendil-works/pi-tui": ">=0.99.0",
		typebox: "*",
	};

	assert.deepEqual(manifest.peerDependencies, expectedHostPeers);
	for (const hostModule of Object.keys(expectedHostPeers)) {
		assert.equal(manifest.dependencies?.[hostModule], undefined);
	}
});

test("host preflight identifies a missing export without installing a patch", () => {
	const fixture = {
		...hostPi,
		createAgentSessionServices: undefined,
	};
	const runtimePrototype = fixture.AgentSessionRuntime.prototype as RuntimePrototype;
	const originalSetRebindSession = runtimePrototype.setRebindSession;

	assert.throws(
		() => installInteractiveHostBridge(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "createAgentSessionServices" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
	assert.equal(
		runtimePrototype.setRebindSession,
		originalSetRebindSession,
	);
});

test("host bridge captures the Runtime without private InteractiveMode members", async (t) => {
	class PublicRuntime extends hostPi.AgentSessionRuntime {}
	class PublicSession extends hostPi.AgentSession {}
	class PublicInteractiveMode {
		getUserInput(): Promise<string> {
			return Promise.resolve("");
		}
	}
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	Object.setPrototypeOf(host.runtime, PublicRuntime.prototype);
	Object.setPrototypeOf(host.session, PublicSession.prototype);
	const bridge = installInteractiveHostBridge({
		...hostPi,
		AgentSession: PublicSession,
		AgentSessionRuntime: PublicRuntime,
		InteractiveMode: PublicInteractiveMode,
	});
	const capture = bridge.capture(
		host.session.sessionManager,
		createPresentationCaptureUi([]),
	);

	host.runtime.setRebindSession(async () => undefined);

	assert.equal((await capture).runtime, host.runtime);
});

test("host bridge follows public Runtime rebinding to a replacement session", { timeout: 1_000 }, async (t) => {
	class PublicRuntime extends hostPi.AgentSessionRuntime {
		observedRebind?: (session: hostPi.AgentSession) => Promise<void>;

		override setRebindSession(
			rebindSession?: (session: hostPi.AgentSession) => Promise<void>,
		): void {
			this.observedRebind = rebindSession;
		}
	}
	class PublicSession extends hostPi.AgentSession {}
	class PublicInteractiveMode {
		getUserInput(): Promise<string> {
			return Promise.resolve("");
		}
	}
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	Object.setPrototypeOf(host.runtime, PublicRuntime.prototype);
	Object.setPrototypeOf(host.session, PublicSession.prototype);
	const bridge = installInteractiveHostBridge({
		...hostPi,
		AgentSession: PublicSession,
		AgentSessionRuntime: PublicRuntime,
		InteractiveMode: PublicInteractiveMode,
	});
	const presentationLifecycle: string[] = [];
	const replacementSessionManager = hostPi.SessionManager.inMemory(host.cwd);
	host.runtime.setRebindSession(async (session) => {
		presentationLifecycle.push("rebind:start");
		await bridge.capture(
			session.sessionManager,
			createPresentationCaptureUi(presentationLifecycle),
		);
		presentationLifecycle.push("rebind:end");
	});
	await bridge.capture(
		host.session.sessionManager,
		createPresentationCaptureUi(presentationLifecycle),
	);

	await (host.runtime as PublicRuntime).observedRebind?.({
		sessionManager: replacementSessionManager,
	} as hostPi.AgentSession);

	assert.deepEqual(presentationLifecycle, [
		"rebind:start",
		"rebind:end",
		"render:true",
	]);
});

test("host preflight rejects a nonnumeric CURRENT_SESSION_VERSION", () => {
	assert.throws(
		() => assertHostModuleShape({
			...hostPi,
			CURRENT_SESSION_VERSION: "3",
		}),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "CURRENT_SESSION_VERSION",
	);
});

test("module preflight rejects every required host export and prototype seam", () => {
	const requirements = [
		["AgentSession"],
		["AgentSessionRuntime"],
		["InteractiveMode"],
		["SessionManager"],
		["DefaultResourceLoader"],
		["ProjectTrustStore"],
		["SettingsManager"],
		["createAgentSessionServices"],
		["createAgentSessionFromServices"],
		["defineTool"],
		["getPackageDir"],
		["hasTrustRequiringProjectResources"],
		["shouldCompact"],
		["CURRENT_SESSION_VERSION"],
		["InteractiveMode", "prototype", "getUserInput"],
		["AgentSessionRuntime", "prototype", "setRebindSession"],
		["AgentSession", "prototype", "bindExtensions"],
		...["create", "open", "continueRecent", "inMemory"].map(
			(member) => ["SessionManager", member],
		),
		...[
			"appendCustomEntry",
			"appendCustomMessageEntry",
			"getEntries",
			"getEntry",
			"getHeader",
			"getSessionId",
			"getSessionFile",
			"getSessionDir",
			"isPersisted",
			"getLeafId",
			"getCwd",
			"branch",
		].map((member) => ["SessionManager", "prototype", member]),
		...["getExtensions", "getSkills", "reload"].map(
			(member) => ["DefaultResourceLoader", "prototype", member],
		),
		["SettingsManager", "create"],
		...["get", "set"].map(
			(member) => ["ProjectTrustStore", "prototype", member],
		),
	] as const;

	for (const path of requirements) {
		const expected = path.join(".");
		assert.throws(
			() => assertHostModuleShape(
				hostModuleWithoutMember(path),
			),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
});

test("module preflight rejects every required TUI, AI, and schema value", () => {
	const tuiRequirements = [
		["Text"],
		["getKeybindings"],
		["matchesKey"],
		["setKeybindings"],
		["visibleWidth"],
		["wrapTextWithAnsi"],
		["Key"],
		...["backspace", "down", "enter", "escape", "left", "right", "space", "tab", "up", "shift"]
			.map((member) => ["Key", member]),
	] as const;
	for (const path of tuiRequirements) {
		const expected = `PiTUI.${path.join(".")}`;
		assert.throws(
			() => assertTuiModuleShape(withoutMemberAtPath({ ...hostTui }, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}

	assert.throws(
		() => assertPiAiModuleShape(withoutMemberAtPath(
			{ ...hostAi },
			["createAssistantMessageEventStream"],
		)),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiAI.createAssistantMessageEventStream",
	);
	for (const path of [
		["Type"],
		...["Array", "Boolean", "Integer", "Literal", "Object", "Optional", "String", "Union"]
			.map((member) => ["Type", member]),
	]) {
		const expected = `TypeBox.${path.join(".")}`;
		assert.throws(
			() => assertTypeboxModuleShape(withoutMemberAtPath({ ...hostTypebox }, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
});

test("live preflight rejects every required runtime and AgentSession seam", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	host.runtime.setRebindSession(async () => undefined);
	host.runtime.setBeforeSessionInvalidate(() => undefined);
	const requirements = [
		[["services"], "AgentSessionRuntime.services"],
		[["services", "cwd"], "AgentSessionRuntime.services.cwd"],
		[["services", "agentDir"], "AgentSessionRuntime.services.agentDir"],
		[["services", "modelRuntime"], "AgentSessionRuntime.services.modelRuntime"],
		[["services", "modelRuntime", "getModel"], "AgentSessionRuntime.services.modelRuntime.getModel"],
		[["services", "settingsManager"], "AgentSessionRuntime.services.settingsManager"],
		...[
			"getDefaultProjectTrust",
			"getShowHardwareCursor",
			"getThemeSetting",
			"isProjectTrusted",
			"getCompactionSettings",
		].map((member) => [
			["services", "settingsManager", member],
			`AgentSessionRuntime.services.settingsManager.${member}`,
		] as const),
		[["services", "resourceLoader"], "AgentSessionRuntime.services.resourceLoader"],
		...["getExtensions", "getSkills", "reload"].map((member) => [
			["services", "resourceLoader", member],
			`AgentSessionRuntime.services.resourceLoader.${member}`,
		] as const),
		[["session"], "AgentSession"],
		...[
			"bindExtensions",
			"prompt",
			"sendUserMessage",
			"sendCustomMessage",
			"clearQueue",
			"subscribe",
			"abort",
			"waitForIdle",
			"dispose",
			"getActiveToolNames",
			"getToolDefinition",
			"getContextUsage",
			"compact",
			"abortCompaction",
		].map((member) => [["session", member], `AgentSession.${member}`] as const),
		...["model", "thinkingLevel", "isIdle", "isCompacting", "sessionId"]
			.map((member) => [["session", member], `AgentSession.${member}`] as const),
		[["session", "extensionRunner"], "AgentSession.extensionRunner"],
		[["session", "agent"], "AgentSession.agent"],
		...["subscribe", "steer", "followUp", "hasQueuedMessages"].map((member) => [
			["session", "agent", member],
			`AgentSession.agent.${member}`,
		] as const),
		[["session", "sessionManager"], "AgentSession.sessionManager"],
		[["session", "settingsManager"], "AgentSession.settingsManager"],
		...[
			"getDefaultProjectTrust",
			"getShowHardwareCursor",
			"getThemeSetting",
			"isProjectTrusted",
			"getCompactionSettings",
		].map((member) => [
			["session", "settingsManager", member],
			`AgentSession.settingsManager.${member}`,
		] as const),
	] as const;

	for (const [path, expected] of requirements) {
		assert.throws(
			() => assertRuntimeInstanceShape(withoutMemberAtPath(host.runtime, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
});

test("live preflight admits a Runtime without private committed-input continuation", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	host.runtime.setRebindSession(async () => undefined);
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	assert.doesNotThrow(() =>
		assertRuntimeInstanceShape(
			withoutMemberAtPath(host.runtime, ["session", "_runAgentPrompt"]),
		),
	);
});

test("preflight rejects read-only prototype seams that coordination mutates", () => {
	for (const [path, expected] of [
		[["InteractiveMode", "prototype", "getUserInput"], "InteractiveMode.prototype.getUserInput"],
		[["AgentSessionRuntime", "prototype", "setRebindSession"], "AgentSessionRuntime.prototype.setRebindSession"],
		[["AgentSession", "prototype", "bindExtensions"], "AgentSession.prototype.bindExtensions"],
	] as const) {
		assert.throws(
			() => assertHostModuleShape(hostModuleWithReadonlyMember(path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}

});

test("extension preflight rejects every required registration seam", () => {
	const api = {
		on() {},
		registerTool() {},
		registerCommand() {},
		appendEntry() {},
		getActiveTools() {},
		setActiveTools() {},
	};
	for (const member of [
		"on",
		"registerTool",
		"registerCommand",
		"appendEntry",
		"getActiveTools",
		"setActiveTools",
	] as const) {
		assert.throws(
			() => assertExtensionApiShape(withoutMemberAtPath(api, [member])),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === `ExtensionAPI.${member}`,
		);
	}
});

test("host preflight validates every running-host TUI value used by presentation", () => {
	const fixture = { ...hostTui, wrapTextWithAnsi: undefined };

	assert.throws(
		() => assertTuiModuleShape(fixture, hostPi.VERSION),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiTUI.wrapTextWithAnsi" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
});

test("host preflight validates running-host AI and schema values", () => {
	assert.throws(
		() => assertPiAiModuleShape(
			{ ...hostAi, createAssistantMessageEventStream: undefined },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiAI.createAssistantMessageEventStream",
	);
	assert.throws(
		() => assertTypeboxModuleShape(
			{ ...hostTypebox, Type: { ...hostTypebox.Type, Object: undefined } },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "TypeBox.Type.Object",
	);
});

test("host bridge installation remains idempotent across extension and host module reload", async () => {
	installInteractiveHostBridge(hostPi);
	const runtimePrototype = hostPi.AgentSessionRuntime.prototype as RuntimePrototype;
	const installedSetRebindSession = runtimePrototype.setRebindSession;
	const reloadedModuleUrl = new URL(
		"../src/pi-integration/interactive-host-bridge.ts",
		import.meta.url,
	);
	reloadedModuleUrl.searchParams.set("reload", "regression");
	const reloadedBridgeModule = (await import(reloadedModuleUrl.href)) as typeof import(
		"../src/pi-integration/interactive-host-bridge.ts"
	);

	// Pi's reload loader recreates the host module namespace while reusing the
	// running host constructors and their prototypes.
	reloadedBridgeModule.installInteractiveHostBridge({ ...hostPi });

	assert.equal(
		runtimePrototype.setRebindSession,
		installedSetRebindSession,
	);
});

test("failed interactive admission restores the Runtime's native rebind callback", async (t) => {
	class PublicRuntime extends hostPi.AgentSessionRuntime {
		observedRebind?: (session: hostPi.AgentSession) => Promise<void>;

		override setRebindSession(
			rebindSession?: (session: hostPi.AgentSession) => Promise<void>,
		): void {
			this.observedRebind = rebindSession;
		}
	}
	class PublicSession extends hostPi.AgentSession {}
	class PublicInteractiveMode {
		getUserInput(): Promise<string> {
			return Promise.resolve("");
		}
	}
	const host = await createUnboundTestOwnerHost(t, () => undefined);
	Object.setPrototypeOf(host.runtime, PublicRuntime.prototype);
	Object.setPrototypeOf(host.session, PublicSession.prototype);
	installInteractiveHostBridge({
		...hostPi,
		AgentSession: PublicSession,
		AgentSessionRuntime: PublicRuntime,
		InteractiveMode: PublicInteractiveMode,
	});
	const nativeRebind = async () => undefined;
	host.runtime.setRebindSession(nativeRebind);
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});

	await assert.rejects(
		() => host.session.bindExtensions({ uiContext: host.ui, mode: "tui" }),
		/AgentSession\.sendCustomMessage/,
	);

	assert.equal((host.runtime as PublicRuntime).observedRebind, nativeRebind);
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	});
});

test("runtime capture rejects a malformed live AgentSession before bootstrap", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const runtimePrototype = hostPi.AgentSessionRuntime.prototype as RuntimePrototype;
	const installedCapture = runtimePrototype.setRebindSession;
	const installedSessionBinding = hostPi.AgentSession.prototype.bindExtensions;
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSession.sendCustomMessage",
	);
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" && entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assert.notEqual(
		runtimePrototype.setRebindSession,
		installedCapture,
		"failed live admission must restore the native Runtime prototype",
	);
	assert.notEqual(
		hostPi.AgentSession.prototype.bindExtensions,
		installedSessionBinding,
		"failed live admission must restore the native session prototype",
	);
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	});
	await host.runtime.dispose();
});

function createPresentationCaptureUi(
	lifecycle: string[],
): hostPi.ExtensionUIContext {
	const tui = {
		stop() {},
		start() {},
		renderNow() {},
		requestRender(force?: boolean) {
			lifecycle.push(`render:${String(force)}`);
		},
		terminal: { write() {} },
	};
	return {
		setWidget(
			_key: string,
			factory: Parameters<hostPi.ExtensionUIContext["setWidget"]>[1],
		) {
			if (typeof factory === "function") factory(tui as never, {} as never);
		},
	} as unknown as hostPi.ExtensionUIContext;
}

function withoutMemberAtPath<T extends object>(
	target: T,
	path: readonly PropertyKey[],
): T {
	const [member, ...rest] = path;
	assert.notEqual(member, undefined);
	return new Proxy(target, {
		get(original, key) {
			if (key !== member) return Reflect.get(original, key, original);
			if (rest.length === 0) return undefined;
			const nested = Reflect.get(original, key, original);
			assert.ok((typeof nested === "object" && nested !== null) || typeof nested === "function");
			return withoutMemberAtPath(nested as object, rest);
		},
		has(original, key) {
			if (key === member && rest.length === 0) return false;
			return Reflect.has(original, key);
		},
	}) as T;
}

function hostModuleWithoutMember(path: readonly PropertyKey[]): object {
	const fixture = { ...hostPi } as Record<PropertyKey, unknown>;
	if (path.length >= 3 && path[1] === "prototype") {
		const constructorName = path[0]!;
		const original = fixture[constructorName] as { prototype: object };
		function MalformedHostConstructor() {}
		Object.setPrototypeOf(MalformedHostConstructor, original);
		MalformedHostConstructor.prototype = withoutMemberAtPath(
			original.prototype,
			path.slice(2),
		);
		fixture[constructorName] = MalformedHostConstructor;
		return fixture;
	}
	return withoutMemberAtPath(fixture, path);
}

function hostModuleWithReadonlyMember(path: readonly PropertyKey[]): object {
	const fixture = { ...hostPi } as Record<PropertyKey, unknown>;
	if (path.length >= 3 && path[1] === "prototype") {
		const constructorName = path[0]!;
		const original = fixture[constructorName] as { prototype: object };
		function ReadonlyHostConstructor() {}
		Object.setPrototypeOf(ReadonlyHostConstructor, original);
		ReadonlyHostConstructor.prototype = readonlyMemberAtPath(
			original.prototype,
			path.slice(2),
		);
		fixture[constructorName] = ReadonlyHostConstructor;
		return fixture;
	}
	return readonlyMemberAtPath(fixture, path);
}

function readonlyMemberAtPath<T extends object>(
	target: T,
	path: readonly PropertyKey[],
): T {
	const [member, ...rest] = path;
	assert.notEqual(member, undefined);
	return new Proxy(target, {
		get(original, key) {
			const value = Reflect.get(original, key, original);
			if (key !== member || rest.length === 0) return value;
			assert.ok((typeof value === "object" && value !== null) || typeof value === "function");
			return readonlyMemberAtPath(value as object, rest);
		},
		getOwnPropertyDescriptor(original, key) {
			if (key === member && rest.length === 0) {
				return {
					configurable: true,
					enumerable: true,
					value: Reflect.get(original, key, original),
					writable: false,
				};
			}
			return Reflect.getOwnPropertyDescriptor(original, key);
		},
	}) as T;
}
