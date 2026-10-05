import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
	bindEquivalent,
	bindPiOwned,
	bindToolInput,
} from "../src/control/schema-conformance.ts";

// Type checking is the drift test: each mismatched binding below must stay a compile error.

type Receipt = Readonly<{ status: "sent"; ids: readonly string[] }> | Readonly<{ status: "failed"; reason?: string }>;
const ReceiptSchema = Type.Union([
	Type.Object({ status: Type.Literal("sent"), ids: Type.Array(Type.String()) }, { additionalProperties: false }),
	Type.Object({ status: Type.Literal("failed"), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
]);

test("an equivalent binding states the domain type and keeps the schema's validation", () => {
	const schema = bindEquivalent<Receipt>()(ReceiptSchema);
	const receipt: Static<typeof schema> = { status: "sent", ids: ["a"] };
	assert.equal(Check(schema, receipt), true);
	assert.equal(Check(schema, { status: "sent" }), false);

	// @ts-expect-error the schema lacks a variant the domain produces
	bindEquivalent<Receipt | Readonly<{ status: "unknown" }>>()(ReceiptSchema);
	// @ts-expect-error the schema allows a variant the domain never produces
	bindEquivalent<Extract<Receipt, { status: "sent" }>>()(ReceiptSchema);
});

test("a tool input binding allows a stricter schema but not a looser one", () => {
	type SearchInput = Readonly<{ query?: string; limit?: number }>;
	const strict = bindToolInput<SearchInput>()(Type.Object({ query: Type.String({ minLength: 1 }) }));
	const input: SearchInput = { query: "x" } satisfies Static<typeof strict>;
	assert.equal(Check(strict, input), true);

	// @ts-expect-error the schema accepts a limit the domain input cannot hold
	bindToolInput<SearchInput>()(Type.Object({ limit: Type.String() }));
});

test("a Pi-owned binding must accept every value Pi's type allows and keeps unnamed fields", () => {
	type PiMessage = Readonly<{ role: "user"; text: string }> | Readonly<{ role: "system"; text: string; extra?: number }>;
	const schema = bindPiOwned<PiMessage>()(Type.Union([
		Type.Object({ role: Type.Literal("user"), text: Type.String() }),
		Type.Object({ role: Type.Literal("system"), text: Type.String() }),
	]));
	assert.equal(Check(schema, { role: "system", text: "x", extra: 1, future: true }), true);

	// @ts-expect-error Pi may send a system message the schema has no variant for
	bindPiOwned<PiMessage>()(Type.Object({ role: Type.Literal("user"), text: Type.String() }));
});
