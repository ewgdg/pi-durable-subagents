import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OwnerRetirement } from "./owner-retirement.ts";

export type RepairHelper = {
	repair(): Promise<void>;
	recordAdmission(admitted: boolean, diagnostic?: string): Promise<void>;
	refuse(reason: string): Promise<void>;
};
export type RepairOutcome = "refused" | "admitted" | "committed_admission_failed";

/** Complete the short native handoff before starting independent repair work. */
export async function startSameTerminalRepair(options: {
	context: ExtensionCommandContext;
	ownerPath: string;
	repairHostPath: string;
	retirement: Pick<OwnerRetirement, "prepare" | "replacementCompleted" | "assertRetired">;
	helper: RepairHelper;
	admission(context: ExtensionCommandContext): boolean;
	beforeReopen?(): Promise<void>;
}): Promise<{ completion: Promise<RepairOutcome> }> {
	const { retirement, helper } = options;
	let outcome: RepairOutcome = "refused";
	let committed = false;
	let presenter = options.context.ui;
	const fail = async (error: unknown) => {
		const diagnostic = error instanceof Error ? error.message : String(error);
		outcome = committed ? "committed_admission_failed" : "refused";
		try {
			if (committed) await helper.recordAdmission(false, diagnostic);
			else await helper.refuse(diagnostic);
		} catch (recordError) {
			presenter.notify(`Repair diagnostics could not be recorded: ${String(recordError)}`, "error");
		}
		presenter.notify(`${committed ? "Repair committed; Owner admission failed" : "Repair refused"}: ${diagnostic}. Use /agents repair for diagnostics and explicit recovery.`, "error");
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
	const host = parked;
	const completion = (async () => {
		try {
			await helper.repair();
			committed = true;
			await options.beforeReopen?.();
			const draft = host.ui.getEditorText();
			const reopened = await host.switchSession(options.ownerPath, {
				withSession: async (fresh) => {
					presenter = fresh.ui;
					try {
						if (draft) fresh.ui.setEditorText(draft);
						if (!options.admission(fresh)) throw new Error("fresh Workflow admission did not succeed");
						await helper.recordAdmission(true);
						outcome = "admitted";
						presenter.notify("Workflow repair committed. Owner reopened idle; send a new message to continue.", "info");
					} catch (error) { await fail(error); }
				},
			});
			if (reopened.cancelled) await fail(new Error("Owner reopening was cancelled"));
		} catch (error) { await fail(error); }
		return outcome;
	})();
	return { completion };
}
