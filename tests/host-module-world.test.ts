import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const PACKAGE_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("Pi's extension loader binds the package entry to the running host module world", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		additionalExtensionPaths: [PACKAGE_ENTRY],
	});

	await bindTestOwnerHost(host, "tui");

	const identity = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "agent-coordination.identity",
	);
	assert.ok(identity);
	assert.ok(host.session.getToolDefinition("agent_spawn"));
	const ownerExtension = host.services.resourceLoader
		.getExtensions()
		.extensions.find((extension) => extension.resolvedPath === PACKAGE_ENTRY);
	assert.ok(ownerExtension);
	assert.equal(ownerExtension.hidden, true);
	await host.runtime.dispose();
});
