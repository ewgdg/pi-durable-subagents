import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { demandedRequestIds } from "../src/coordination/owner-demand.ts";

function awaits(requesterAgentId: string, requestId: string, targetAgentId: string) {
	return { requestId, requesterAgentId, targetAgentId };
}

test("demand flows from the Owner and Moderators through unanswered Requests only", () => {
	const demanded = demandedRequestIds(["owner", "moderator"], [
		awaits("owner", "owner-to-a", "a"),
		awaits("a", "a-to-b", "b"),
		awaits("b", "b-to-a", "a"),
		awaits("moderator", "moderator-to-c", "c"),
		// The Owner cancelled its Request to x, so x's own Request is orphaned.
		awaits("x", "x-to-y", "y"),
		awaits("y", "y-to-z", "z"),
		// A cycle nobody upstream needs.
		awaits("p", "p-to-q", "q"),
		awaits("q", "q-to-p", "p"),
	]);
	assert.deepEqual([...demanded].sort(), ["a-to-b", "b-to-a", "moderator-to-c", "owner-to-a"]);
});
