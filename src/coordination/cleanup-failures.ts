/** Runs one cleanup step and records its failure instead of stopping later steps. */
export async function collectCleanupFailure(
	errors: unknown[],
	cleanup: () => unknown | Promise<unknown>,
): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		appendCleanupFailure(errors, error);
	}
}

export function collectSettledCleanupFailures(
	errors: unknown[],
	results: readonly PromiseSettledResult<unknown>[],
): void {
	for (const result of results) {
		if (result.status === "rejected") appendCleanupFailure(errors, result.reason);
	}
}

function appendCleanupFailure(errors: unknown[], error: unknown): void {
	if (error instanceof AggregateError) {
		for (const nested of error.errors) appendCleanupFailure(errors, nested);
		return;
	}
	errors.push(error);
}
