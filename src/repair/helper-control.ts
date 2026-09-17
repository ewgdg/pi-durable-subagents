import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import { AGENT_CONTROL_PROTOCOL_VERSION, type ControlEndpoint } from "../control/control-protocol-schemas.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import { readRepairLaunch } from "./repair-launch.ts";

/** Control carries lifecycle/navigation only. Conversation uses the native PTY. */
export const repairControlProtocol = {
	methods: {
		command: { request: Type.Object({ action: Type.String(), payload: Type.Optional(Type.Unknown()) }), response: Type.Unknown() },
		navigate: { request: Type.Object({ target: Type.Union([Type.Literal("owner"), Type.Literal("inspect"), Type.Literal("cancel"), Type.Literal("recover"), Type.Literal("recover-stopped")]) }), response: Type.Unknown() },
	},
	events: {
		ready: { payload: Type.Object({ error: Type.Optional(Type.String()) }) },
		progress: { payload: Type.Object({ message: Type.String() }) },
	},
} as const;
export type RepairControlChannel = FramedAgentControlChannel<typeof repairControlProtocol>;
export type RepairControlDescriptor = { endpoint: ControlEndpoint; connectionToken: string; attemptId: string };

export async function connectRepairControl(bootstrapPath: string) {
	const launch = await readRepairLaunch(bootstrapPath);
	const descriptor = JSON.parse(await readFile(join(dirname(bootstrapPath), "control.json"), "utf8")) as RepairControlDescriptor;
	if (descriptor.attemptId !== launch.attemptId || typeof descriptor.connectionToken !== "string" || !descriptor.connectionToken) throw new Error("Repair control does not match this attempt");
	const transport = await connectControlTransport(descriptor.endpoint);
	const channel = new FramedAgentControlChannel({ transport, protocol: repairControlProtocol,
		identity: { protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION, workflowId: launch.owner.workflowId, agentId: launch.moderatorAgentId } });
	await channel.sendHello({ connectionToken: descriptor.connectionToken, expectedSessionId: launch.moderatorAgentId });
	return { launch, channel };
}
