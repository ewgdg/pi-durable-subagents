import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import {
	createModelVisibleModeratorObligationReminder,
	inspectModeratorObligationReminder,
	moderatorObligationReminderDeliveryId,
} from "../src/protocol/moderator-obligation-reminder.ts";

test("Moderator reminder proves one exact visible delivery per handling identity", () => {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomMessageEntry("agent-coordination.moderator-input", "{}", true, {
		agentId: session.getSessionId(),
	});
	const moderatorAgentId = session.getSessionId();
	const inspect = () => inspectModeratorObligationReminder({
		moderatorAgentId, transcript: transcriptFromSessionManager(session).inspect(),
	});
	assert.equal(inspect(), undefined);
	const reminder = createModelVisibleModeratorObligationReminder();
	assert.match(reminder.content, /original Moderator Input/);
	assert.match(reminder.content, /affected Agents and Requests/);
	assert.match(reminder.content, /only when the original condition clears/);
	const entryId = session.appendCustomMessageEntry(reminder.customType, reminder.content, reminder.display);
	assert.deepEqual(inspect(), { agentId: moderatorAgentId, entryId });
	assert.notEqual(moderatorObligationReminderDeliveryId(moderatorAgentId),
		moderatorObligationReminderDeliveryId("replacement-moderator"));
	session.appendCustomMessageEntry(reminder.customType, reminder.content, reminder.display);
	assert.throws(inspect, /duplicate Deliveries/);
});

test("Moderator reminder rejects hidden or contradictory delivery evidence", () => {
	for (const [content, display] of [["Wrong guidance", true], [createModelVisibleModeratorObligationReminder().content, false]] as const) {
		const session = SessionManager.inMemory(process.cwd());
		session.appendCustomMessageEntry("agent-coordination.moderator-input", "{}", true, {
			agentId: session.getSessionId(),
		});
		const reminder = createModelVisibleModeratorObligationReminder();
		session.appendCustomMessageEntry(reminder.customType, content, display);
		assert.equal(inspectModeratorObligationReminder({
			moderatorAgentId: session.getSessionId(),
			transcript: transcriptFromSessionManager(session).inspect(),
		}), undefined);
	}
});
