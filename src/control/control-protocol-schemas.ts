import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { RuntimeThinkingSchema } from "../protocol/runtime-thinking-schema.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	ChildProcessBootstrapSchema,
	ControlEndpointSchema,
	NamedPipeControlEndpointSchema,
	UnixControlEndpointSchema,
} from "./child-bootstrap-contract.ts";
export {
	AGENT_CONTROL_PROTOCOL_VERSION,
	ChildProcessBootstrapSchema,
	ControlEndpointSchema,
	NamedPipeControlEndpointSchema,
	UnixControlEndpointSchema,
} from "./child-bootstrap-contract.ts";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const ControlIdentityProperties = {
	protocolVersion: Type.Literal(AGENT_CONTROL_PROTOCOL_VERSION),
	workflowId: NonEmptyStringSchema,
	agentId: NonEmptyStringSchema,
} as const;

export const AgentTemplateCatalogueEntrySchema = Type.Object({
	name: NonEmptyStringSchema,
	useWhen: Type.Optional(NonEmptyStringSchema),
	models: Type.Optional(Type.Array(Type.Object({
		model: Type.Object({
			provider: NonEmptyStringSchema,
			modelId: NonEmptyStringSchema,
		}, { additionalProperties: false }),
		thinking: RuntimeThinkingSchema,
	}, { additionalProperties: false }), { minItems: 1, uniqueItems: true })),
	excludeTools: Type.Optional(Type.Array(NonEmptyStringSchema, { uniqueItems: true })),
	excludeSkills: Type.Optional(Type.Array(NonEmptyStringSchema, { uniqueItems: true })),
	extensions: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("none")])),
	systemPromptMode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
	loadContextFiles: Type.Boolean(),
}, { additionalProperties: false });

export const AgentTemplateCatalogueSnapshotSchema = Type.Object({
	templates: Type.Array(AgentTemplateCatalogueEntrySchema),
}, { additionalProperties: false });

export type ControlEndpoint = Static<typeof ControlEndpointSchema>;
export type UnixControlEndpoint = Static<typeof UnixControlEndpointSchema>;
export type NamedPipeControlEndpoint = Static<typeof NamedPipeControlEndpointSchema>;

export type ChildProcessBootstrap = Static<typeof ChildProcessBootstrapSchema>;

export const HelloFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("hello"),
	connectionToken: NonEmptyStringSchema,
	expectedSessionId: NonEmptyStringSchema,
}, { additionalProperties: false });

export const RequestFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("request"),
	requestId: NonEmptyStringSchema,
	method: NonEmptyStringSchema,
	payload: Type.Unknown(),
}, { additionalProperties: false });

const ResponseErrorSchema = Type.Object({
	code: NonEmptyStringSchema,
	message: Type.String(),
}, { additionalProperties: false });

export const SuccessfulResponseFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("response"),
	requestId: NonEmptyStringSchema,
	ok: Type.Literal(true),
	result: Type.Unknown(),
}, { additionalProperties: false });

export const FailedResponseFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("response"),
	requestId: NonEmptyStringSchema,
	ok: Type.Literal(false),
	error: ResponseErrorSchema,
}, { additionalProperties: false });

export const ResponseFrameSchema = Type.Union([
	SuccessfulResponseFrameSchema,
	FailedResponseFrameSchema,
]);

export const EventFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("event"),
	sequence: Type.Integer({ minimum: 1 }),
	event: NonEmptyStringSchema,
	payload: Type.Unknown(),
}, { additionalProperties: false });

export const CancelFrameSchema = Type.Object({
	...ControlIdentityProperties,
	type: Type.Literal("cancel"),
	requestId: NonEmptyStringSchema,
}, { additionalProperties: false });

export const ControlFrameSchema = Type.Union([
	HelloFrameSchema,
	RequestFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema,
	CancelFrameSchema,
]);

export type HelloFrame = Static<typeof HelloFrameSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type CancelFrame = Static<typeof CancelFrameSchema>;
export type ControlFrame = Static<typeof ControlFrameSchema>;

/** What clears one rejected child or Moderator launch. Every message carries exactly one. */
export type ChildLaunchBlockRemedy =
	| "restart_owner_host"
	| "repair_extension"
	| "investigate_probe"
	| "retry_agent_launch";

const CHILD_LAUNCH_BLOCK_DUTY = "Stop child and Moderator launches. Owner: report this diagnostic to the user immediately; ask the user to stop active work.";

const CHILD_LAUNCH_REMEDIES: Readonly<Record<ChildLaunchBlockRemedy, string>> = {
	// This host loaded different code than the installed files; a restart aligns them.
	restart_owner_host: "Restart the Pi host that runs the Workflow Owner to load the installed extension; retrying launches in that host cannot clear the block.",
	// The installed files cannot provide a contract a fresh Node process can import.
	repair_extension: "Repair the installed extension so a fresh Node process can import its child launch contract, then restart the Pi host that runs the Workflow Owner; retrying launches in that host cannot clear the block.",
	// Nothing about the installation was verified: the probe itself never ran.
	investigate_probe: "The launch probe could not run, so the installed extension was not verified; check Node subprocess startup in this Pi host, then restart it. Retrying launches in this host cannot clear the block.",
	// A per-Agent handoff defect: a fresh launch can succeed, so no host-wide block is claimed.
	retry_agent_launch: "Relaunch this Agent; if the same failure repeats, the Workflow Owner staged an unusable descriptor, so restart the Pi host that runs the Workflow Owner.",
};

/**
 * The remedy for one rejection. Host-wide launch blocks also carry the duty to stop
 * launching; a per-Agent handoff defect carries only its own remedy.
 */
export function childLaunchBlockGuidance(remedy: ChildLaunchBlockRemedy): string {
	return remedy === "retry_agent_launch"
	? CHILD_LAUNCH_REMEDIES.retry_agent_launch
	: `${CHILD_LAUNCH_BLOCK_DUTY} ${CHILD_LAUNCH_REMEDIES[remedy]}`;
}

/** A contract that cannot be read as a protocol version is unusable, not merely different. */
export function childLaunchContractRemedy(installedVersion: unknown, hostVersion: unknown): ChildLaunchBlockRemedy {
	return isProtocolVersion(installedVersion) && isProtocolVersion(hostVersion)
	? "restart_owner_host"
	: "repair_extension";
}

export function validateChildProcessBootstrap(value: unknown): ChildProcessBootstrap {
	if (!Check(ChildProcessBootstrapSchema, value)) {
		throw new Error(
			`${bootstrapFailureDetail(value)}. ${childLaunchBlockGuidance("restart_owner_host")}`,
		);
	}
	return value;
}

export function validateControlEndpoint(value: unknown): ControlEndpoint {
	if (!Check(ControlEndpointSchema, value)) {
		throw new Error("control_endpoint_invalid: endpoint descriptor is invalid");
	}
	return value;
}

function bootstrapFailureDetail(value: unknown): string {
	const descriptor = typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown> : {};
	const version = descriptor.protocolVersion;
	const missing: string[] = [];
	const invalid: string[] = [];
	for (const [field, schema] of Object.entries(ChildProcessBootstrapSchema.properties)) {
		if (descriptor[field] === undefined) missing.push(field);
		else if (!Check(schema, descriptor[field])) invalid.push(field);
	}
	const extra = Object.keys(descriptor).some(field => !(field in ChildProcessBootstrapSchema.properties));
	return describeChildBootstrapFailure(AGENT_CONTROL_PROTOCOL_VERSION, version, missing, invalid, extra);
}

/** Values and unknown descriptor keys must never enter a bootstrap diagnostic. */
export function describeChildBootstrapFailure(
	loadedVersion: unknown,
	descriptorVersion: unknown,
	missingFields: readonly string[],
	invalidFields: readonly string[],
	unexpectedFields = false,
): string {
	return `control_bootstrap_${bootstrapDisagreementCategory(loadedVersion, descriptorVersion)}: the loaded child launch contract is version ${bootstrapVersion(loadedVersion)}, the received bootstrap descriptor is version ${bootstrapVersion(descriptorVersion)}; missing descriptor fields: ${bootstrapFields(missingFields)}; invalid descriptor fields: ${bootstrapFields(invalidFields)}${unexpectedFields ? "; unexpected fields present" : ""}`;
}

/**
 * The launch probe compares the installed contract against the copy this host loaded
 * when it started. Naming both sides keeps the repair unambiguous: a disagreement
 * means a host running different code, not necessarily a stale installation.
 */
export function describeChildLaunchContractSkew(
	installedVersion: unknown,
	hostVersion: unknown,
	missingFields: readonly string[],
	differingFields: readonly string[],
): string {
	return `control_bootstrap_${bootstrapDisagreementCategory(installedVersion, hostVersion)}: the installed extension provides child launch contract version ${bootstrapVersion(installedVersion)}, this host loaded version ${bootstrapVersion(hostVersion)}; fields the installed contract requires and this host lacks: ${bootstrapFields(missingFields)}; fields defined differently: ${bootstrapFields(differingFields)}`;
}

function bootstrapDisagreementCategory(firstVersion: unknown, secondVersion: unknown): "invalid" | "schema_drift" | "protocol_mismatch" {
	if (!isProtocolVersion(firstVersion) || !isProtocolVersion(secondVersion)) return "invalid";
	return firstVersion === secondVersion ? "schema_drift" : "protocol_mismatch";
}

function bootstrapVersion(version: unknown): string | number {
	return isProtocolVersion(version) ? version : "invalid or missing";
}

function bootstrapFields(fields: readonly string[]): string {
	return fields.join(", ") || "none";
}

function isProtocolVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}
