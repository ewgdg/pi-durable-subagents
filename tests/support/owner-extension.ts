import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { createOwnerExtension } from "../../src/index.ts";
import {
	WorkflowCoordinator,
	type OrdinaryAgentCoordinatorView,
} from "../../src/coordination/workflow-coordinator.ts";
import type { OwnerIdentity } from "../../src/protocol/owner-identity.ts";

type WorkflowCoordinatorOptions = ConstructorParameters<typeof WorkflowCoordinator>[2];

export type TestOwnerExtension = Readonly<{
	extension: ExtensionFactory;
	/** The coordinator the Owner extension built at its most recent admission. */
	coordinator(): WorkflowCoordinator;
	/** The admitted Owner's participant view on that coordinator. */
	owner(): OrdinaryAgentCoordinatorView;
}>;

/**
 * The production Owner extension, with test boundary hooks, clocks, or policy
 * applied over the production coordinator options at every admission.
 */
export function createTestOwnerExtension(
	overrides: Partial<WorkflowCoordinatorOptions> = {},
): TestOwnerExtension {
	let latest: { coordinator: WorkflowCoordinator; identity: OwnerIdentity } | undefined;
	const requireLatest = () => {
		if (!latest) throw new Error("The test Owner extension has not admitted an Owner");
		return latest;
	};
	return {
		extension: createOwnerExtension((runtime, identity, options) => {
			const coordinator = new WorkflowCoordinator(runtime, identity, { ...options, ...overrides });
			latest = { coordinator, identity };
			return coordinator;
		}),
		coordinator: () => requireLatest().coordinator,
		owner: () => {
			const { coordinator, identity } = requireLatest();
			return coordinator.forAgent(identity.agentId);
		},
	};
}
