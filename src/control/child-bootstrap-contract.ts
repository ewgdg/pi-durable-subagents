// Keep this canonical JSON Schema dependency-free: the fresh-process launch probe
// cannot resolve peer modules supplied only by Pi's extension loader.
// Version 8 made the required initial tools selection an incompatible contract.
// Version 9 replaces that selection with a required exclusion filter: the child
// keeps its own runtime default surface plus its role coordination tools.
export const AGENT_CONTROL_PROTOCOL_VERSION = 10 as const;

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
		"role", "ownerPresentation", "excludedTools", "expectedSessionId",
	],
	properties: {
		protocolVersion: { type: "number", const: AGENT_CONTROL_PROTOCOL_VERSION },
		endpoint: ControlEndpointSchema,
		connectionToken: NonEmptyStringSchema,
		workflowId: NonEmptyStringSchema,
		agentId: NonEmptyStringSchema,
		role: { anyOf: [{ type: "string", const: "ordinary" }, { type: "string", const: "moderator" }] },
		ownerPresentation: { type: "boolean" },
		// Names removed from the child's own runtime default surface. Role
		// coordination tools always stay active, and absent names are ignored.
		excludedTools: { type: "array", items: NonEmptyStringSchema, uniqueItems: true },
		expectedSessionId: NonEmptyStringSchema,
	},
	additionalProperties: false,
} as const;
