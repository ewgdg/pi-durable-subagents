import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	createPiCliTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const OWNER_HOST_FACTORIES = [
	["bound", createTestOwnerHost],
	["unbound", createUnboundTestOwnerHost],
	["Pi CLI", createPiCliTestOwnerHost],
] as const;

for (const [label, createHost] of OWNER_HOST_FACTORIES) {
		test(`${label} test Owner hosts dispose after the acquiring test`, async (t) => {
		let host: TestOwnerHost | undefined;
		const cleanupOrder: string[] = [];
		await t.test("acquire", async (childTest) => {
			host = await createHost(childTest, (pi) => {
				pi.on("session_shutdown", () => {
					cleanupOrder.push("runtime");
				});
			});
			host.deferCleanup(() => {
				cleanupOrder.push("deferred");
			});
			childTest.after(() => {
				assert.deepEqual(cleanupOrder, ["deferred", "runtime"]);
			});
		});

		assert.ok(host);
	});
}
