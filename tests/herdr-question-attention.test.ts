import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrQuestionAttention } from "../src/pi-integration/herdr-question-attention.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("root question attention coalesces questions and ignores autonomous activity", () => {
	let pending = false;
	const changes = new Set<() => void>();
	const handlers = new Map<string, () => void>();
	const events: unknown[] = [];
	registerHerdrQuestionAttention({
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		events: { emit: (name: string, data: unknown) => events.push({ name, data }) },
	} as unknown as ExtensionAPI, () => ({
		hasPendingHumanQuestions: () => pending,
		addAgentActivityChangeHandler: (handler: () => void) => {
			changes.add(handler);
			return () => { changes.delete(handler); };
		},
	}));
	handlers.get("resources_discover")!();
	assert.deepEqual(events, []);
	pending = true;
	for (const change of changes) change();
	for (const change of changes) change(); // another question or worker progress
	assert.deepEqual(events, [{ name: "herdr:blocked", data: { active: true, label: "An agent needs your input" } }]);
	pending = false;
	for (const change of changes) change();
	assert.deepEqual(events.at(-1), { name: "herdr:blocked", data: { active: false } });
	assert.equal(events.length, 2);
	handlers.get("session_shutdown")!();
	assert.equal(changes.size, 0);
	assert.equal(events.length, 2);
});

test("shutdown balances an active blocker and reload reconstructs only current questions", () => {
	let pending = true;
	const changes = new Set<() => void>();
	const handlers = new Map<string, () => void>();
	const events: unknown[] = [];
	const pi = {
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		events: { emit: (_name: string, data: unknown) => events.push(data) },
	} as unknown as ExtensionAPI;
	const source = {
		hasPendingHumanQuestions: () => pending,
		addAgentActivityChangeHandler: (handler: () => void) => {
			changes.add(handler);
			return () => { changes.delete(handler); };
		},
	};
	registerHerdrQuestionAttention(pi, () => source);
	assert.deepEqual(events, [], "wait until all session_start handlers have initialized");
	handlers.get("resources_discover")!();
	handlers.get("resources_discover")!();
	assert.equal(changes.size, 1);
	handlers.get("session_shutdown")!();
	handlers.get("session_shutdown")!();
	assert.deepEqual(events, [{ active: true, label: "An agent needs your input" }, { active: false }]);
	assert.equal(changes.size, 0);
	registerHerdrQuestionAttention(pi, () => source);
	handlers.get("resources_discover")!();
	assert.equal(events.length, 3);
	pending = false;
	for (const change of changes) change();
	assert.deepEqual(events.at(-1), { active: false });
	handlers.get("session_shutdown")!();
	assert.equal(events.length, 4);
});

test("unadmitted and headless sessions do not publish or subscribe", () => {
	const handlers = new Map<string, () => void>();
	registerHerdrQuestionAttention({
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		events: { emit: () => assert.fail("inactive session published attention") },
	} as unknown as ExtensionAPI, () => undefined);
	handlers.get("resources_discover")!();
	handlers.get("session_shutdown")!();
});
