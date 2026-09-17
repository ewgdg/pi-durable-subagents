import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OwnerRetirement } from "./owner-retirement.ts";

export type RepairHelper = {
	repair(): Promise<void>;
	refuse(reason: string): Promise<void>;
};
export type RepairOutcome = "refused" | "committed_awaiting_admission" | "admitted" | "committed_admission_failed";

/** Complete the short native handoff before starting independent repair work. */
export async function startSameTerminalRepair(options: {
	context: ExtensionCommandContext;
	repairHostPath: string;
	retirement: Pick<OwnerRetirement, "prepare" | "replacementCompleted" | "assertRetired">;
	helper: RepairHelper;
}): Promise<{ context?: ExtensionCommandContext; completion: Promise<RepairOutcome> }> {
	const { retirement, helper } = options;
	let outcome: RepairOutcome = "refused";
	let presenter = options.context.ui;
	const fail = async (error: unknown) => {
		const diagnostic = error instanceof Error ? error.message : String(error);
		outcome = "refused";
		try {
			await helper.refuse(diagnostic);
		} catch (recordError) {
			presenter.notify(`Repair diagnostics could not be recorded: ${String(recordError)}`, "error");
		}
		presenter.notify(`Repair refused: ${diagnostic}. Use /agents repair for diagnostics and explicit recovery.`, "error");
	};
	let parked: ExtensionCommandContext | undefined;
	try {
		await retirement.prepare();
		const transition = await options.context.switchSession(options.repairHostPath, {
			withSession: async (fresh) => {
				presenter = fresh.ui;
				// Pi treats a callback throw as fatal. Keep this callback short and
				// contain expected failures before returning editor ownership.
				try {
					retirement.replacementCompleted();
					retirement.assertRetired();
					parked = fresh;
				} catch (error) { await fail(error); }
			},
		});
		if (transition.cancelled) await fail(new Error("repair-host replacement was cancelled"));
	} catch (error) { await fail(error); }
	if (!parked) return { completion: Promise.resolve(outcome) };
	const completion = (async () => {
		try {
			await helper.repair();
			// Completion changes disk authority, not the user's selected conversation.
			outcome = "committed_awaiting_admission";
		} catch (error) { await fail(error); }
		return outcome;
	})();
	return { context: parked, completion };
}
