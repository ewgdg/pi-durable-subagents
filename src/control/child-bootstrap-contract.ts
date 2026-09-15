// Keep this canonical JSON Schema dependency-free: the fresh-process launch probe
// cannot resolve peer modules supplied only by Pi's extension loader.
// Version 8 makes the required initial tools selection an incompatible contract.
export const AGENT_CONTROL_PROTOCOL_VERSION = 8 as const;

const NonEmptyStringSchema = { type: "string", minLength: 1 } as const;

export const UnixControlEndpointSchema = {
	type: "object",
	required: ["transport", "address"],
	properties: {
		transport: { type: "string", const: "unix" },
		address: NonEmptyStringSchema,
	},
	additionalProperties: false,
} as const;

export const NamedPipeControlEndpointSchema = {
	type: "object",
	required: ["transport", "address"],
	properties: {
		transport: { type: "string", const: "named-pipe" },
		address: NonEmptyStringSchema,
	},
	additionalProperties: false,
} as const;

export const ControlEndpointSchema = {
	anyOf: [UnixControlEndpointSchema, NamedPipeControlEndpointSchema],
} as const;

export const ChildProcessBootstrapSchema = {
	type: "object",
	required: [
		"protocolVersion", "endpoint", "connectionToken", "workflowId", "agentId",
		"role", "ownerPresentation", "tools", "expectedSessionId",
	],
	properties: {
		protocolVersion: { type: "number", const: AGENT_CONTROL_PROTOCOL_VERSION },
		endpoint: ControlEndpointSchema,
		connectionToken: NonEmptyStringSchema,
		workflowId: NonEmptyStringSchema,
		agentId: NonEmptyStringSchema,
		role: { anyOf: [{ type: "string", const: "ordinary" }, { type: "string", const: "moderator" }] },
		ownerPresentation: { type: "boolean" },
		tools: { type: "array", items: NonEmptyStringSchema, uniqueItems: true },
		expectedSessionId: NonEmptyStringSchema,
	},
	additionalProperties: false,
} as const;
