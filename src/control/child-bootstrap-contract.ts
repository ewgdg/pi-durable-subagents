// Keep this canonical JSON Schema dependency-free: the fresh-process launch probe
// cannot resolve peer modules supplied only by Pi's extension loader.
// Version 8 made the required initial tools selection an incompatible contract.
// Version 9 replaces that selection with a required exclusion filter: the child
// keeps its own runtime default surface plus its role coordination tools.
// Version 11 adds the required Workflow interaction, which withholds ask_user headless.
// Version 13 adds Virtual Model preset thinking to the bootstrap and catalogue candidates.
// Version 14 removes preset thinking from the bootstrap: the child's session records it.
export const AGENT_CONTROL_PROTOCOL_VERSION = 14 as const;

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
		"role", "ownerPresentation", "interaction", "excludedTools", "expectedSessionId",
	],
	properties: {
		protocolVersion: { type: "number", const: AGENT_CONTROL_PROTOCOL_VERSION },
		endpoint: ControlEndpointSchema,
		connectionToken: NonEmptyStringSchema,
		workflowId: NonEmptyStringSchema,
		agentId: NonEmptyStringSchema,
		role: { anyOf: [{ type: "string", const: "ordinary" }, { type: "string", const: "moderator" }] },
		ownerPresentation: { type: "boolean" },
		// A headless Workflow has no human to answer ask_user.
		interaction: { anyOf: [{ type: "string", const: "terminal" }, { type: "string", const: "headless" }] },
		// Names removed from the child's own runtime default surface. Role
		// coordination tools always stay active, and absent names are ignored.
		excludedTools: { type: "array", items: NonEmptyStringSchema, uniqueItems: true },
		expectedSessionId: NonEmptyStringSchema,
	},
	additionalProperties: false,
} as const;
