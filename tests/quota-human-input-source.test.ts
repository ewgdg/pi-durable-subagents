import assert from "node:assert/strict";
import test from "node:test";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import {
	registerParticipantInputLifecycle,
	type ParticipantHumanInput,
	type ParticipantLifecycleHandlers,
} from "../src/pi-integration/participant-lifecycle.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const text = "Resume this Agent with these instructions.";
const images: NonNullable<InputEvent["images"]> = [{
	type: "image", mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
}];

for (const route of ["interactive", "rpc", "extension", "sdk-default"] as const) {
	test(`native quota input provenance: ${route}`, { timeout: 5_000 }, async t => {
		const submissions: ParticipantHumanInput[] = [];
		const nativeInputs: InputEvent[] = [];
		const handlers: ParticipantLifecycleHandlers = {
			async humanInputSubmitted(input) { submissions.push(input); return "submitted"; },
			async executionStarted() { return []; },
			async primaryInputQueued() {},
			async humanInputMode() { return "agent"; },
			async toolResultCommitting() {},
			async toolExecutionStarted() {},
			async safeBoundaryReached() {},
			async executionEnded() {},
		};
		const host = await createTestOwnerHost(t, pi => {
			pi.on("input", event => { nativeInputs.push(event); });
			registerParticipantInputLifecycle(pi, handlers);
			// Stop rejected provenance before generation: this test owns routing,
			// not the coordinator's separate quota admission policy.
			pi.on("input", () => ({ action: "handled" }));
		});
		if (route === "extension") {
			await host.session.sendUserMessage([{ type: "text", text }, ...images]);
		} else {
			await host.session.prompt(text, { images, ...(route === "sdk-default" ? {} : { source: route }) });
		}
		assert.equal(nativeInputs.length, 1);
		assert.equal(nativeInputs[0]!.source, route === "sdk-default" ? "interactive" : route);
		assert.equal(nativeInputs[0]!.text, text);
		assert.deepEqual(nativeInputs[0]!.images, images);
		// Pi defaults direct SDK prompt() to interactive. Provenance is a
		// trusted caller contract, not proof that a physical human typed input.
		assert.deepEqual(submissions, route === "interactive" || route === "sdk-default"
			? [{ text, images }] : []);
		assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "message").length, 0,
			"handled input is not also appended as a second native user turn");
	});
}
