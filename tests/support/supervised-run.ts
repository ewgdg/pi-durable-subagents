import { failTestFileOnLeakedHandles } from "./leaked-handles.ts";

// Direct `node --test` skips the supervisor's process containment, and an
// interrupted or hung direct run has leaked spinning test workers and Pi
// processes that outlived their shell. Refuse it unless explicitly accepted.
// (docs/development.md, "Running tests".)
if (process.env.PI_TEST_SUPERVISED !== "1" && process.env.PI_TEST_UNSUPERVISED !== "1") {
	throw new Error(
		"Run tests through `npm run test:fast|test:process|test:conformance`; focus with " +
		"`-- --file=<name>.test.ts --test-name-pattern=<pattern>`. " +
		"Set PI_TEST_UNSUPERVISED=1 to run without process containment.",
	);
}

// Every test file imports this module first; see docs/development.md,
// "Deadlines and containment".
failTestFileOnLeakedHandles();
