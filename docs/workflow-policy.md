# Workflow Policy

The Workflow Owner loads one optional user policy from Pi's agent configuration area:

```text
<getAgentDir()>/config/pi-durable-subagents.json
```

The file is a strict UTF-8 JSON object. Its complete optional surface is:

```json
{
  "maxConcurrentAgentRuns": 8,
  "maxPendingDeliveriesPerAgent": 256,
  "operationReviewIntervalMs": 600000,
  "deliveryProgressIntervalMs": 60000
}
```

An omitted file or field uses the shown default. Unknown fields, duplicate keys, comments, trailing commas, wrong types, and invalid integers reject the complete file. Execution and delivery limits must be positive safe integers. `operationReviewIntervalMs` and `deliveryProgressIntervalMs` must each be an integer from `1000` through `2147483647` milliseconds.

Invalid initial policy prevents coordination from creating the Workflow runtime. Owner resource reload reads the file again: a valid file atomically publishes one frozen complete snapshot, while an invalid file reports a diagnostic and preserves the previous snapshot. Reloading child resources does not reload Workflow Policy. Policy is volatile Owner-scoped configuration; it is not written to any Agent transcript.

## Child execution

`maxConcurrentAgentRuns` is the maximum number of child Agent Runs that may execute concurrently across the Workflow. A child Run consumes one slot only while Pi is generating or executing its tools. A ready child Run that cannot enter waits in Workflow-wide FIFO order before generation starts.

The single Workflow Owner Run always enters immediately and consumes no child slot. Moderator Runs are also immediate and consume no child slot. Total concurrent work may therefore include the configured number of child Agent Runs, the Owner Run, and exempt Moderator work.

Queued, settled, held, input-required, Agent-Answer-waiting, ending, and dormant child Runs consume no execution slot. A pending child `agent_wait` reacquires capacity before its aggregate tool result can commit. A reduced limit does not preempt active child work: each ready child execution keeps the complete policy snapshot captured at its admission and enters when current child usage falls below that captured limit.

## Pending Message delivery

`maxPendingDeliveriesPerAgent` limits distinct pending Message identities separately for each recipient. Deferred and Steer scheduling share the limit. Same-identity retry coalesces without using another slot.

Each new distinct delivery admission uses the policy snapshot current at that admission. Lowering capacity never evicts admitted Messages. Exhaustion rejects only the new volatile scheduling request with `capacity_exhausted`; the canonical author Message remains available for later explicit retry. An exact-Hold Supervisory Resume Message keeps its separate reserved slot.

## Operation Review interval

`operationReviewIntervalMs` limits one applicable review interval for each unresolved root Pi tool call owned by an answer-obligated Agent. Each call captures the complete policy snapshot current at execution admission, so reload affects only later calls.

A blocking call starts its interval at execution admission. An asynchronous call starts an interval only when its Agent reaches an unattended Idle boundary. A Moderator may renew an exact current call for a positive interval no greater than the value captured by that call. Longer observation therefore requires another deliberate renewal; policy reload never stretches an admitted call's bound.

## Delivery progress interval

`deliveryProgressIntervalMs` bounds a continuous interval during which Delivery machinery is responsible for advancing an eligible Message toward transcript commitment. The default is one minute; ordinary model generation and parked Agent Wait are not part of this interval.

Each observed scheduling admission captures its interval. An eligible delivery starts timing at its first live eligibility observation; reservation and dispatch restart the captured interval. Transcript proof or suppression ends observation. Execution-capacity waiting, an active recipient, Request admission behind an existing Answer Obligation, Human attention, selection, and Holds suspend applicable delivery timing. Regained eligibility starts a fresh captured interval. Polls, heartbeats, logs, and policy reload do not extend it. A known lost scheduling continuation qualifies immediately instead of waiting for expiry.

The same current policy value bounds one moderation inspection/bootstrap pass, including replacement creation after terminal Moderator failure, before reporting passive Owner attention if that pass does not complete. This watchdog does not abort the pass or retry any effects. See [Operational Incident moderation](operational-incident-moderation.md) for dependency qualification and exclusions.
