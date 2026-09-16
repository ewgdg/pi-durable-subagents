import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OwnerRetirement } from "./owner-retirement.ts";

export type RepairHelper = {
	/** Called only with positively verified retirement; resolves after durable commit. */
	repair(): Promise<void>;
	recordAdmission(admitted: boolean, diagnostic?: string): Promise<void>;
	refuse(reason: string): Promise<void>;
};

export type RepairOutcome = "refused" | "admitted" | "committed_admission_failed";

/** The CLI remains the presenter; only its native session is replaced. */
export async function runSameTerminalRepair(options: {
	context: ExtensionCommandContext;
	ownerPath: string;
	repairHostPath: string;
	retirement: Pick<OwnerRetirement, "prepare" | "replacementCompleted" | "assertRetired">;
	helper: RepairHelper;
	admission(context: ExtensionCommandContext): boolean;
}): Promise<RepairOutcome> {
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
	try {
		await retirement.prepare();
		const transition = await options.context.switchSession(options.repairHostPath, {
			withSession: async (parked) => {
				presenter = parked.ui;
				// Expected refusals MUST NOT escape withSession: Pi can treat callback
				// rejection as fatal, losing the same-terminal diagnostic presenter.
				try {
					retirement.replacementCompleted();
					retirement.assertRetired();
					await helper.repair();
					committed = true;
					const reopened = await parked.switchSession(options.ownerPath, {
						withSession: async (fresh) => {
							presenter = fresh.ui;
							try {
								if (!options.admission(fresh)) throw new Error("fresh Workflow admission did not succeed");
								await helper.recordAdmission(true);
								outcome = "admitted";
								presenter.notify("Workflow repair committed. Owner reopened; participant Runs remain dormant.", "info");
							} catch (error) { await fail(error); }
						},
					});
					if (reopened.cancelled) await fail(new Error("Owner reopening was cancelled"));
				} catch (error) { await fail(error); }
			},
		});
		if (transition.cancelled) await fail(new Error("repair-host replacement was cancelled"));
	} catch (error) { await fail(error); }
	return outcome;
}
