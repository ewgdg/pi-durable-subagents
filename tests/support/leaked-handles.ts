import { createHook } from "node:async_hooks";
import { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// Handles a test already closed, such as `server.close()` or `child.kill()`,
// finish closing within this grace; anything still open after it is a leak.
const LEFTOVER_GRACE_MS = 2_000;
const LEFTOVER_POLL_MS = 25;
// Node internals fill the default 10 frames before reaching the creating code.
const CREATION_STACK_TRACE_LIMIT = 40;
const CREATION_FRAMES_SHOWN = 6;

type RefableResource = { hasRef(): boolean };
type ResourceCreation = Readonly<{
	type: string;
	stack: string;
	resource: WeakRef<RefableResource>;
}>;

/**
 * Fails the current test file when its tests finish but leave resources that
 * keep the process alive. `--test-force-exit` would otherwise hide them, and a
 * leaked handle hangs a runner without it.
 */
export function failTestFileOnLeakedHandles(): void {
	const baseline = process.getActiveResourcesInfo();
	const liveCreations = trackRefableResourceCreations();
	// Registered before the test file's body, so this runs before any file-level
	// `after` hook: cleanup must belong to a test (`t.after`, `t.signal`) or a
	// `describe` suite, whose hooks finish first. Deferring registration past the
	// file's own hooks has no reliable moment: a file of synchronous tests can
	// finish within a macrotask, and a top-level await in its imports lets a
	// microtask run before the file's body.
	after(async () => {
		const leftovers = await leftoverResourcesAfterGrace(baseline);
		if (leftovers.length === 0) return;
		throw new Error(
			`${process.argv[1]} left resources keeping its process alive after its tests finished: `
			+ `${leftovers.join(", ")}. Close them with cleanup owned by a test or suite `
			+ "(t.after, t.signal, or a describe-level after).\n"
			+ describeCreations(liveCreations()),
		);
	});
}

// The Node docs discourage `createHook` for production use; here it only runs
// under the test supervisor, to name the code that created a leaked resource.
function trackRefableResourceCreations(): () => ResourceCreation[] {
	const creationStacks = new Map<number, string>();
	const refableCreations = new Map<number, ResourceCreation>();
	createHook({
		init(asyncId, type, triggerAsyncId, resource) {
			if (type === "PROMISE") return;
			// A resource created from a Node callback, such as a server bound after
			// a host lookup, has no frames of its own; its trigger's stack names
			// the code that started it.
			const stack = captureCreationStack() || creationStacks.get(triggerAsyncId);
			// Nothing to attribute, e.g. this module's own grace timers; the leftover
			// list still names the type of any such resource left open.
			if (!stack) return;
			creationStacks.set(asyncId, stack);
			if (isRefable(resource)) {
				refableCreations.set(asyncId, { type, stack, resource: new WeakRef(resource) });
			}
		},
		destroy(asyncId) {
			creationStacks.delete(asyncId);
			refableCreations.delete(asyncId);
		},
	}).enable();
	return () => [...refableCreations.values()]
		.filter((creation) => creation.resource.deref()?.hasRef() === true);
}

function isRefable(resource: object): resource is RefableResource {
	return typeof (resource as Partial<RefableResource>).hasRef === "function";
}

function captureCreationStack(): string {
	const defaultLimit = Error.stackTraceLimit;
	Error.stackTraceLimit = CREATION_STACK_TRACE_LIMIT;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = defaultLimit;
	return stack.split("\n").slice(1)
		.filter((frame) => !/\(node:|at node:|\(<anonymous>\)/.test(frame) && !frame.includes(import.meta.url))
		.slice(0, CREATION_FRAMES_SHOWN)
		.join("\n");
}

async function leftoverResourcesAfterGrace(baseline: readonly string[]): Promise<string[]> {
	const deadline = Date.now() + LEFTOVER_GRACE_MS;
	let leftovers = resourcesBeyond(baseline);
	while (leftovers.length > 0 && Date.now() < deadline) {
		await delay(LEFTOVER_POLL_MS);
		leftovers = resourcesBeyond(baseline);
	}
	return leftovers;
}

function resourcesBeyond(baseline: readonly string[]): string[] {
	const unmatchedBaseline = [...baseline];
	return process.getActiveResourcesInfo().filter((resource) => {
		const index = unmatchedBaseline.indexOf(resource);
		if (index === -1) return true;
		unmatchedBaseline.splice(index, 1);
		return false;
	});
}

function describeCreations(creations: readonly ResourceCreation[]): string {
	const counts = new Map<string, number>();
	for (const { type, stack } of creations) {
		const description = `${type} created at:\n${stack}`;
		counts.set(description, (counts.get(description) ?? 0) + 1);
	}
	return [...counts].map(([description, count]) =>
		count === 1 ? description : `${count}x ${description}`).join("\n");
}
