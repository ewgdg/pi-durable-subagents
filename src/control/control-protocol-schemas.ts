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

export const CHILD_LAUNCH_ALIGNMENT_GUIDANCE = "Stop child and Moderator launches. Owner: report this diagnostic to the user immediately; ask them to stop active work and correct the reported problem (align installed packages if incompatible), then restart the Pi host.";

export function validateChildProcessBootstrap(value: unknown): ChildProcessBootstrap {
	if (!Check(ChildProcessBootstrapSchema, value)) {
		throw new Error(
			`${bootstrapFailureDetail(value)}. ${CHILD_LAUNCH_ALIGNMENT_GUIDANCE}`,
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
	expectedVersion: unknown,
	receivedVersion: unknown,
	missingFields: readonly string[],
	invalidFields: readonly string[],
	unexpectedFields = false,
): string {
	const validExpectedVersion = typeof expectedVersion === "number" && Number.isSafeInteger(expectedVersion);
	const validVersion = typeof receivedVersion === "number" && Number.isSafeInteger(receivedVersion);
	const category = !validExpectedVersion || !validVersion ? "invalid"
		: receivedVersion === expectedVersion ? "schema_drift" : "protocol_mismatch";
	return `control_bootstrap_${category}: expected ${validExpectedVersion ? expectedVersion : "invalid or missing"}, received ${validVersion ? receivedVersion : "invalid or missing"}; missing fields: ${missingFields.join(", ") || "none"}; invalid fields: ${invalidFields.join(", ") || "none"}${unexpectedFields ? "; unexpected fields present" : ""}`;
}
