import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
	AgentControlEventSchema,
	agentControlEvents,
	AgentControlMethodSchema,
	agentControlMethods,
	RuntimeSnapshotSchema,
} from "../src/control/agent-control-protocol.ts";
import {
	AgentTemplateCatalogueSnapshotSchema,
	ChildProcessBootstrapSchema,
	ControlEndpointSchema,
	ControlFrameSchema,
	validateChildProcessBootstrap,
} from "../src/control/control-protocol-schemas.ts";

const identity = { protocolVersion: 8, workflowId: "workflow", agentId: "agent" } as const;

test("control transports local Answer commitment without fabricating Delivery proof", () => {
	const schema = agentControlMethods["coordination.message"].response;
	const receipt = { disposition: "committed", delivery: "omitted", reason: "request_source_unavailable",
		messageId: "answer", requestMessageId: "request", requestTitle: "Preserved work" };
	assert.ok(Check(schema, receipt));
	assert.equal(Check(schema, { ...receipt, delivery: "delivered" }), false);
	assert.equal(Check(schema, { ...receipt, deliveryEvidence: { agentId: "requester", entryId: "fabricated" } }), false);
	assert.equal(Check(schema, { ...receipt, messageStatus: "sent" }), false);
	assert.equal(Check(schema, { ...receipt, requestTitle: "" }), false);
});

test("Request observation schemas keep lists compact and inspection complete", () => {
	const schema = agentControlMethods["coordination.observe"];
	const summary = { requestMessageId: "request", requesterAgentId: "requester", title: "Verify storage" };
	assert.ok(Check(schema.request, { operation: "obligations" }));
	assert.equal(Check(schema.request, { operation: "obligations", agentId: "other" }), false);
	assert.ok(Check(schema.request, { operation: "request", requestId: "request" }));
	assert.equal(Check(schema.request, { operation: "request", requestId: "  " }), false);
	assert.ok(Check(schema.response, { requests: [summary] }));
	assert.equal(Check(schema.response, { requests: [{ ...summary, question: "Body must not appear in list" }] }), false);
	assert.equal(Check(schema.response, { requests: [{ ...summary, title: "  " }] }), false);
	assert.ok(Check(schema.response, { ...summary, responderAgentId: "responder", question: "Full instructions" }));
	assert.equal(Check(schema.response, { ...summary, responderAgentId: "responder" }), false);
});

test("Control Endpoint and child bootstrap descriptors are closed and versioned", () => {
	const endpoint = { transport: "unix", address: "/tmp/control.sock" } as const;
	const namedPipeEndpoint = {
		transport: "named-pipe",
		address: "\\\\.\\pipe\\pi-ac-control",
	} as const;
	const bootstrap = {
		protocolVersion: 8,
		endpoint,
		connectionToken: "token",
		workflowId: "workflow",
		agentId: "agent",
		role: "ordinary",
		ownerPresentation: true,
		tools: [],
		expectedSessionId: "session",
	} as const;
	assert.equal(Check(ControlEndpointSchema, endpoint), true);
	assert.equal(Check(ControlEndpointSchema, namedPipeEndpoint), true);
	assert.deepEqual(validateChildProcessBootstrap(bootstrap), bootstrap);
	assert.deepEqual(
		validateChildProcessBootstrap({ ...bootstrap, endpoint: namedPipeEndpoint }),
		{ ...bootstrap, endpoint: namedPipeEndpoint },
	);
	for (const protocolVersion of [identity.protocolVersion - 1, identity.protocolVersion + 1]) {
		assert.throws(() => validateChildProcessBootstrap({ ...bootstrap, protocolVersion }), /control_bootstrap_protocol_mismatch/);
		assert.equal(Check(ControlFrameSchema, {
			...identity, protocolVersion, type: "hello", connectionToken: "token", expectedSessionId: "session",
		}), false);
	}
	assert.equal(Check(ChildProcessBootstrapSchema, { ...bootstrap, unixPath: endpoint.address }), false);
	assert.equal(Check(ControlEndpointSchema, { ...endpoint, extra: true }), false);
	assert.equal(Check(ControlEndpointSchema, { ...namedPipeEndpoint, extra: true }), false);
});

test("Agent Template Catalogue Snapshot contains only Template guidance", () => {
	const snapshot = { templates: [] };
	assert.equal(Check(AgentTemplateCatalogueSnapshotSchema, snapshot), true);
	assert.equal(Check(AgentTemplateCatalogueSnapshotSchema, {
		...snapshot,
		currentRuntime: {
			model: { provider: "stale", modelId: "model" },
			thinking: "high",
		},
	}), false);
});

test("Control frame schema is a closed hello/request/response/event/cancel union", () => {
	const frames = [
		{ ...identity, type: "hello", connectionToken: "token", expectedSessionId: "session" },
		{ ...identity, type: "request", requestId: "1", method: "runtime.snapshot", payload: {} },
		{ ...identity, type: "response", requestId: "1", ok: true, result: {} },
		{ ...identity, type: "response", requestId: "1", ok: false, error: { code: "failed", message: "no" } },
		{ ...identity, type: "event", sequence: 1, event: "runtime.ready", payload: {} },
		{ ...identity, type: "cancel", requestId: "1" },
	];
	for (const frame of frames) assert.equal(Check(ControlFrameSchema, frame), true);
	assert.equal(Check(ControlFrameSchema, { ...frames[1], unexpected: true }), false);
	assert.equal(Check(ControlFrameSchema, { ...identity, type: "response", requestId: "1", ok: true }), false);
	assert.equal(Check(ControlFrameSchema, {
		...identity,
		type: "response",
		requestId: "1",
		ok: false,
		error: { code: "failed", message: "no" },
		result: {},
	}), false);
});

test("every version-eight method and event has TypeBox payload/result schemas", () => {
	assert.deepEqual(Object.keys(agentControlMethods), [
		"runtime.snapshot",
		"runtime.executionBegin",
		"runtime.humanInput",
		"runtime.primaryInputQueued",
		"runtime.humanInputMode",
		"runtime.guardToolResult",
		"runtime.toolExecutionStart",
		"runtime.safeBoundary",
		"runtime.executionEnd",
		"coordination.observe",
		"coordination.message",
		"coordination.wait",
		"coordination.control",
		"coordination.spawn",
		"coordination.templateSnapshot",
		"coordination.askHuman",
		"coordination.reportToUser",
		"presentation.reports.setRead",
		"coordination.moderatorControl",
		"presentation.agents.snapshot",
		"presentation.agents.select",
		"presentation.setVisible",
		"message.deliver",
		"message.cancel",
		"moderatorReminder.prepare",
		"moderatorReminder.finish",
		"queue.clear",
		"run.interrupt",
		"runtime.shutdown",
	]);
	assert.deepEqual(Object.keys(agentControlEvents), [
		"runtime.ready",
		"runtime.startupComplete",
		"runtime.snapshot.changed",
		"runtime.input.submissionAcknowledged",
		"runtime.input.started",
		"runtime.input.completed",
		"runtime.compaction.started",
		"runtime.compaction.completed",
		"agent.start",
		"agent.end",
		"agent.settled",
		"message.dispatch.completed",
		"presentation.agents.changed",
		"coordination.wait.progress",
		"session.shutdown",
		"runtime.fault",
	]);
	assert.equal(Check(AgentControlMethodSchema, "runtime.snapshot"), true);
	assert.equal(Check(AgentControlMethodSchema, "message.deliver"), true);
	assert.equal(Check(AgentControlMethodSchema, "queue.clear"), true);
	assert.equal(Check(AgentControlMethodSchema, "run.interrupt"), true);
	assert.equal(Check(AgentControlMethodSchema, "presentation.setVisible"), true);
	assert.equal(Check(agentControlMethods["presentation.setVisible"].request, {
		visible: false,
	}), true);
	assert.equal(Check(agentControlMethods["presentation.setVisible"].request, {}), false);
	assert.equal(Check(agentControlMethods["presentation.setVisible"].request, {
		visible: false,
		extra: true,
	}), false);
	assert.equal(Check(AgentControlMethodSchema, "runtime.unknown"), false);
	assert.equal(Check(AgentControlEventSchema, "runtime.snapshot.changed"), true);
	assert.equal(Check(AgentControlEventSchema, "runtime.input.submissionAcknowledged"), true);
	assert.equal(Check(AgentControlEventSchema, "runtime.input.started"), true);
	assert.equal(Check(AgentControlEventSchema, "runtime.input.completed"), true);
	assert.equal(Check(AgentControlEventSchema, "runtime.compaction.started"), true);
	assert.equal(Check(AgentControlEventSchema, "runtime.compaction.completed"), true);
	assert.equal(Check(AgentControlEventSchema, "agent.settled"), true);
	assert.equal(Check(AgentControlEventSchema, "coordination.wait.progress"), true);
	assert.equal(Check(AgentControlEventSchema, "agent.unknown"), false);
	for (const definition of Object.values(agentControlMethods)) {
		assert.equal(typeof definition.request, "object");
		assert.equal(typeof definition.response, "object");
	}
	for (const definition of Object.values(agentControlEvents)) {
		assert.equal(typeof definition.payload, "object");
	}
	assert.equal(Check(agentControlEvents["agent.start"].payload, {
		runId: "run-1",
		queuedInputCount: 1,
	}), true);
	assert.equal(Check(agentControlEvents["agent.end"].payload, {
		runId: "run-1",
		outcome: "interrupted",
		willRetry: false,
		queuedInputCount: 0,
	}), true);
	assert.equal(Check(agentControlEvents["agent.settled"].payload, {
		runId: "run-1",
		outcome: "interrupted",
		queuedInputCount: 0,
	}), true);
	const preparedRequestDelivery = {
		deliveryId: "prepared-delivery",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.message-delivery",
				content: JSON.stringify({ messages: [{
					title: "Fixture request",
					kind: "request",
					requestMessageId: "request-1",
					fromAgentId: "requester-1",
					question: "Continue using prior context.",
				}] }),
				display: true,
				details: { messages: [{
					agentId: "requester-1",
					entryId: "entry-1",
					toolCallId: "request-1",
				}] },
			},
			triggerTurn: true,
			workingZonePreparation: {
				intent: { workScale: "large", contextDependence: "high" },
				prospectiveRequest: {
					title: "Fixture request",
					kind: "request",
					requestMessageId: "request-1",
					fromAgentId: "requester-1",
					question: "Continue using prior context.",
				},
			},
		},
	};
	assert.equal(Check(
		agentControlMethods["message.deliver"].request,
		preparedRequestDelivery,
	), true);
	assert.equal(Check(
		agentControlMethods["message.deliver"].request,
		{
			...preparedRequestDelivery,
			delivery: {
				...preparedRequestDelivery.delivery,
				workingZonePreparation: {
					intent: { workScale: "large" },
					prospectiveRequest: preparedRequestDelivery.delivery
						.workingZonePreparation.prospectiveRequest,
				},
			},
		},
	), false);
	assert.equal(Check(agentControlEvents["coordination.wait.progress"].payload, {
		toolCallId: "wait-call",
		progress: {
			waitingFor: [{
				requestTitle: "Fixture request",
				requestMessageId: "request-1",
				responderAgentId: "responder-1",
			}],
		},
	}), true);
	assert.equal(Check(agentControlEvents["coordination.wait.progress"].payload, {
		toolCallId: "wait-call",
		progress: { waitingFor: [] },
	}), false);
	const validRuntimeSnapshot = {
		cwd: "/project",
		model: { provider: "provider", modelId: "model" },
		thinking: "high",
		tools: ["read"],
		skills: ["review"],
		skillSources: [{ name: "review", filePath: "/skills/review/SKILL.md" }],
		extensions: ["/extensions/review.ts"],
		toolExecutionModes: [{ name: "read", executionMode: "parallel" }],
		projectTrusted: true,
		sessionId: "session",
		sessionPath: "/sessions/session.jsonl",
		systemPrompt: null,
		loadContextFiles: true,
	} as const;
	assert.equal(Check(RuntimeSnapshotSchema, validRuntimeSnapshot), true);
	assert.equal(Check(agentControlEvents["runtime.snapshot.changed"].payload, validRuntimeSnapshot), true);
	const { toolExecutionModes: _missingToolModes, ...missingToolModes } = validRuntimeSnapshot;
	assert.equal(Check(RuntimeSnapshotSchema, missingToolModes), false);
	assert.equal(Check(agentControlMethods["runtime.humanInput"].request, {
		text: "continue",
		images: [{ type: "image", data: "base64", mimeType: "image/png" }],
		submissionSequence: 3,
	}), true);
	assert.equal(Check(agentControlMethods["runtime.humanInput"].request, {
		text: "continue",
		submissionSequence: 3,
		extra: true,
	}), false);
	assert.equal(Check(agentControlMethods["coordination.message"].request, {
		toolCallId: "call-message",
		input: { operation: "send", targetAgent: "target", content: "hello" },
	}), true);
	assert.equal(Check(agentControlMethods["coordination.message"].request, {
		toolCallId: "call-message-with-removed-target-field",
		input: { operation: "send", targetAgentId: "target", content: "hello" },
	}), false);
	assert.equal(Check(agentControlMethods["coordination.message"].request, {
		toolCallId: "call-cancel",
		input: {
			operation: "cancel",
			requestMessageId: "request-message",
			reason: "No longer needed.",
		},
	}), true);
	assert.equal(Check(agentControlMethods["coordination.message"].request, {
		toolCallId: "call-obsolete-cancel",
		input: {
			operation: "cancel",
			requestId: "request-message",
			reason: "No longer needed.",
		},
	}), false);
	assert.equal(Check(agentControlMethods["coordination.message"].response, {
		messageId: "message",
		targetAgentId: "target",
		messageStatus: "sent",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.message"].response, {
		requestMessageId: "request-message",
		targetAgentId: "target",
		messageStatus: "sent",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.message"].response, {
		messageId: "message-without-target",
		messageStatus: "sent",
	}), false);
	assert.equal(Check(agentControlMethods["coordination.message"].response, {
		disposition: "rejected",
		reason: "answer_required",
		requestMessageId: "request-message",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.message"].response, {
		disposition: "already_cancelled",
		cancellationMessageId: "cancellation-message",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.wait"].request, {
		toolCallId: "call-wait",
		input: {},
	}), true);
	assert.equal(Check(agentControlMethods["coordination.wait"].request, {
		toolCallId: "call-selected-wait",
		input: { requestMessageIds: ["request-message"] },
	}), true);
	assert.equal(Check(agentControlMethods["coordination.wait"].request, {
		toolCallId: "call-empty-selection-wait",
		input: { requestMessageIds: [] },
	}), false);
	assert.equal(Check(agentControlMethods["coordination.wait"].response, {
		disposition: "preempted",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.wait"].response, {
		disposition: "preempted",
		answers: [],
	}), false);
	assert.equal(Check(agentControlMethods["coordination.control"].response, {
		agentId: "child",
		messageId: "resume-message",
		messageStatus: "sent",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.spawn"].response, {
		spawnStatus: "created",
		agentId: "child",
		requestMessageId: "creation-request",
		messageStatus: "sent",
		effectiveConfiguration: {
			cwd: "/project",
			model: { provider: "provider", modelId: "model" },
			thinking: "high",
			tools: ["read"],
			skills: [],
			extensions: [],
			loadContextFiles: true,
		},
	}), true);
	assert.equal(Check(agentControlMethods["coordination.spawn"].response, {
		spawnStatus: "not_created",
		failedStage: "configuration",
		reason: "Configured Agent model is unavailable: provider/model",
	}), true);
	assert.equal(Check(agentControlMethods["coordination.spawn"].response, {
		spawnStatus: "not_created",
		failedStage: "identity_commit",
	}), false);
	assert.equal(Check(agentControlMethods["coordination.observe"].response, {
		matches: [{
			agentId: "child",
			workflowId: "workflow",
			label: "Child",
			directSpawnerAgentId: "owner",
			primaryEvidence: {
				transcriptPath: null,
				inspectedThrough: { agentId: "child", entryId: "entry" },
			},
			run: { phase: "dormant", retentionReasons: [] },
		}],
		hasMore: false,
	}), true);
	assert.equal(Check(agentControlMethods["coordination.observe"].response, {
		matches: [{ agentId: "child" }],
		hasMore: false,
	}), false);
	assert.equal(Check(agentControlMethods["coordination.observe"].response, {
		matches: Array.from({ length: 51 }, (_, index) => ({
			agentId: `child-${index}`,
			workflowId: "workflow",
			label: "Child",
			directSpawnerAgentId: "owner",
			primaryEvidence: {
				transcriptPath: null,
				inspectedThrough: { agentId: `child-${index}`, entryId: "entry" },
			},
			run: { phase: "dormant", retentionReasons: [] },
		})),
		hasMore: true,
	}), false);
	const selectorSnapshot = {
		live: [{
			agentId: "workflow",
			workflowId: "workflow",
			label: "Owner",
			directSpawnerAgentId: null,
			primaryEvidence: {
				transcriptPath: "/sessions/workflow.jsonl",
				inspectedThrough: { agentId: "workflow", entryId: "owner-entry" },
			},
			run: {
				phase: "live",
				work: "settled",
				attention: "none",
				retentionReasons: [{ reason: "owner_host_binding", count: 1 }],
			},
			model: { provider: "provider", modelId: "model" },
			thinking: "high",
			compacting: false,
			queuedInputCount: 0,
		}],
		dormant: [],
		reports: [],
		selectedAgentId: "child",
		humanAttention: [{
			requestId: "human-request",
			agentId: "child",
			agentLabel: "Child",
			question: "Proceed?",
		}],
		operationalAttention: [{
			trigger: {
				kind: "operation_review",
				toolCall: { agentId: "child", entryId: "entry", toolCallId: "tool" },
				reviewIntervalMs: 1_000,
			},
			affectedAgents: [{ agentId: "child", label: "Child" }],
			diagnostics: [{ agentId: "moderator", entryId: "diagnostic" }],
		}],
	} as const;
	assert.equal(Check(agentControlMethods["presentation.agents.snapshot"].response, selectorSnapshot), true);
	assert.equal(Check(agentControlMethods["presentation.agents.snapshot"].response, {
		...selectorSnapshot,
		channelId: "must-not-cross-domain-boundary",
	}), false);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].request, {
		kind: "decide",
		requestId: "human-request",
		agentId: "child",
	}), true);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].request, {
		kind: "select_agent",
		agentId: "child",
		unixPath: "/tmp/control.sock",
	}), false);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].response, {
		kind: "selected",
	}), true);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].response, {
		kind: "post_mortem",
		agentId: "child",
		label: "Failed Agent",
		preparationError: "Configured model is unavailable",
		outcome: "back",
	}), true);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].response, {
		kind: "post_mortem",
		agentId: "child",
		label: "Failed Agent",
		preparationError: "",
		outcome: "back",
	}), false);
	assert.equal(Check(agentControlMethods["presentation.agents.select"].response, {
		kind: "post_mortem",
		agentId: "child",
		label: "Failed Agent",
		preparationError: "x".repeat(2_001),
		outcome: "back",
	}), false);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "user",
			content: [
				{ type: "text", text: "Direction", textSignature: "signature" },
				{ type: "image", data: "base64", mimeType: "image/png" },
			],
			deliverAs: "steer",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.message-delivery",
				content: "{\"messages\":[]}",
				display: true,
				details: {
					messages: [{ agentId: "sender", entryId: "entry", toolCallId: "call" }],
				},
			},
			triggerTurn: true,
			deliverAs: "followUp",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.message-delivery",
				content: "{\"messages\":[]}",
				display: true,
				details: {
					messages: [{ agentId: "sender", entryId: "entry", toolCallId: "call" }],
				},
			},
			triggerTurn: false,
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.obligation-reminder",
				content: "{\"requestMessageId\":\"request-1\",\"requestTitle\":\"Answer now.\"}",
				display: true,
			},
			triggerTurn: true,
			deliverAs: "followUp",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.moderator-obligation-reminder",
				content: "Inspect the original Moderator Input.",
				display: true,
			},
			triggerTurn: true,
			deliverAs: "followUp",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.run-failure-recovery",
				content: "{\"recovery\":{\"kind\":\"successor_run_started\",\"successorRunSequence\":2}}",
				display: true,
			},
			triggerTurn: true,
			deliverAs: "followUp",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "delivery-1",
		delivery: { kind: "user", content: "Direction", retry: true },
	}), false);
	assert.equal(Check(agentControlMethods["message.deliver"].response, {
		accepted: true,
		transcriptCommitted: true,
		modelCycleStarted: true,
		queuedInputCount: 0,
	}), true);
	assert.equal(Check(agentControlEvents["message.dispatch.completed"].payload, {
		deliveryId: "delivery-1",
	}), true);
	assert.equal(Check(agentControlEvents["message.dispatch.completed"].payload, {
		deliveryId: "delivery-1", error: "dispatch failed",
	}), true);
	assert.equal(Check(agentControlEvents["message.dispatch.completed"].payload, {}), false);
	assert.equal(Check(agentControlMethods["run.interrupt"].request, {}), false);
	assert.equal(Check(agentControlMethods["run.interrupt"].request, {
		runId: "run-1",
	}), true);
	assert.equal(Check(agentControlMethods["queue.clear"].request, {}), false);
	assert.equal(Check(agentControlMethods["queue.clear"].request, {
		runId: "run-1",
	}), true);
	assert.equal(Check(agentControlMethods["queue.clear"].response, {
		steering: ["one"],
		followUp: ["two"],
		queuedInputCount: 0,
	}), true);
});

test("Control snapshots carry runtime diagnostic reports but reject invented tool or reporter provenance", () => {
	const report = { reportId: "runtime-report", createdAt: "2026-06-11T00:00:00Z",
		source: { kind: "runtime_diagnostic", agentId: "owner", entryId: "diagnostic", transcriptPath: "/tmp/owner.jsonl" },
		symptom: "Inspection unavailable", suspectedDefect: "Unknown", uncertainty: "No incident established",
		recoveryActions: "None", recoveryOutcome: "Still unavailable", evidence: ["owner/diagnostic"],
	};
	const snapshot = { live: [], dormant: [], humanAttention: [], operationalAttention: [], reports: [{ report, readAt: report.createdAt }], selectedAgentId: "owner" };
	const schema = agentControlMethods["presentation.agents.snapshot"].response;
	assert.ok(Check(schema, JSON.parse(JSON.stringify(snapshot))));
	const attention = { trigger: { kind: "moderation_unavailable" }, affectedAgents: [], diagnostics: [] };
	assert.ok(Check(schema, { ...snapshot, operationalAttention: [attention] }));
	assert.equal(Check(schema, { ...snapshot, operationalAttention: [{
		...attention, trigger: { kind: "obligation_stall", agentId: "worker", obligations: { total: 1, sources: [] } },
	}] }), false, "an established incident still requires an affected Agent");
	for (const invalid of [ { ...report, reporter: { agentId: "owner", label: "Owner" } }, { ...report, source: { ...report.source, toolCallId: "fake" } } ]) {
		assert.equal(Check(schema, { ...snapshot, reports: [{ report: invalid }] }), false);
	}
});

test("bootstrap incompatibility diagnostics distinguish versions and safe field failures", () => {
	const descriptor = {
		protocolVersion: 8,
		endpoint: { transport: "unix", address: "/tmp/control.sock" },
		connectionToken: "SECRET-TOKEN", workflowId: "workflow", agentId: "agent",
		role: "ordinary", ownerPresentation: true, tools: [], expectedSessionId: "session",
	};
	assert.doesNotThrow(() => validateChildProcessBootstrap(descriptor));
	for (const [value, pattern] of [
		[{ ...descriptor, protocolVersion: 7, tools: undefined }, /protocol_mismatch: expected 8, received 7; missing fields: tools/],
		[{ ...descriptor, tools: undefined }, /schema_drift: expected 8, received 8; missing fields: tools/],
		[{ ...descriptor, tools: 42 }, /schema_drift.*invalid fields: tools/],
		[{ ...descriptor, protocolVersion: "SECRET-TOKEN" }, /invalid fields: protocolVersion/],
	] as const) {
		assert.throws(() => validateChildProcessBootstrap(value), (error: Error) => {
			assert.match(error.message, pattern);
			assert.match(error.message, /Stop.*align.*restart/i);
			assert.match(error.message, /Owner: report.*user immediately/);
			assert.match(error.message, /restart the Pi host running this Workflow/);
			assert.match(error.message, /inspect interrupted tool effects.*workflow_resume/);
			assert.doesNotMatch(error.message, /SECRET-TOKEN|control.sock/);
			return true;
		});
	}
});
