import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import {
	createModelVisibleObligationReminder,
	obligationReminderEntryIds,
	OBLIGATION_REMINDER_GUIDANCE,
	obligationReminderDeliveryId,
} from "../src/protocol/obligation-reminder.ts";

test("Obligation Reminder contains the exact Request title and durable correlation", () => {
	const requestTitle = "Review the evidence";
	const reminder = createModelVisibleObligationReminder({
		requestMessageId: "request-1",
		requestTitle,
	});
	const content = JSON.parse(reminder.content) as {
		requestMessageId: string;
		requestTitle: string;
		guidance: string;
	};

	assert.equal(reminder.customType, "agent-coordination.obligation-reminder");
	assert.equal(reminder.display, true);
	assert.deepEqual(Object.keys(content).sort(), [
		"guidance",
		"requestMessageId",
		"requestTitle",
	]);
	assert.equal(content.requestMessageId, "request-1");
	assert.equal(content.guidance, OBLIGATION_REMINDER_GUIDANCE);
	assert.equal(content.guidance, "This Request still needs an Answer. Choose which outstanding Request to work on or answer; attention order does not prescribe execution order. Send each Answer as a standalone agent_message operation \"answer\" call, then end the turn without a summary.");
	assert.equal(content.requestTitle, requestTitle);
	assert.equal(
		obligationReminderDeliveryId("request-1"),
		JSON.stringify(["obligation_reminder", "request-1"]),
	);
	assert.equal(
		obligationReminderDeliveryId("request-1", 1),
		JSON.stringify(["obligation_reminder", "request-1", "after_human_interruption", 1]),
	);
});

test("Obligation Reminder entries list each runtime-authored Delivery in transcript order", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const reminder = createModelVisibleObligationReminder({
		requestMessageId: "request-2",
		requestTitle: "Provide the exact Answer now.",
	});
	const appendReminder = () =>
		sessionManager.appendCustomMessageEntry(reminder.customType, reminder.content, reminder.display);
	const entryIds = () => obligationReminderEntryIds({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		requestMessageId: "request-2",
		requestTitle: "Provide the exact Answer now.",
	});

	assert.deepEqual(entryIds(), []);
	const first = appendReminder();
	// Free reminders after human interruption make several Deliveries legitimate.
	const second = appendReminder();
	assert.deepEqual(entryIds(), [first, second]);
});
