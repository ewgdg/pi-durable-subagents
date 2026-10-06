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
  "deliveryProgressIntervalMs": 60000,
  "excludedModels": ["openai-codex/*", "deepseek/deepseek-v4-flash"]
}
```

An omitted file or field uses the shown default. Unknown fields, duplicate keys, comments, trailing commas, wrong types, and invalid integers reject the complete file. `maxConcurrentAgentRuns` and `maxPendingDeliveriesPerAgent` must each be a positive safe integer. `operationReviewIntervalMs` and `deliveryProgressIntervalMs` must each be an integer from `1000` through `2147483647` milliseconds. `excludedModels` defaults to an empty list.

Invalid initial policy does not block admission: the Owner starts with the default policy, and a warning names the problem. Owner resource reload reads the file again: a valid file atomically publishes one frozen complete snapshot, while an invalid file warns and preserves the previous snapshot. Model-exclusion toggles still refuse to rewrite an invalid file. Reloading child resources does not reload Workflow Policy. Policy is volatile Owner-scoped configuration; it is not written to any Agent transcript.

## Concurrent Agent Runs

`maxConcurrentAgentRuns` is an approximate bound on spawned children doing model work at the same time. It is not a hard limit. The Owner and Moderators never count. A child's Run counts while it is starting, or live or ending with no attention and either active work or a Delivery about to dispatch. Agent Wait, human input, Run Suspension, an Interruption Hold, and a settled Run kept live by retention do not count.

When a spawned child would boot while the count is at the bound, its boot is deferred and nothing is rejected. `agent_spawn` and `agent_message` report the Delivery as admitted. The child stays dormant with its Delivery pending, and it boots once a Workflow activity change finds a free slot. Deferred boots start in deferral order, and a later child queues behind them even when a slot is free. Status observation reports the child as `{ "phase": "dormant", "queued": true }`, and `/agents` lists it as `queued` on the Live tab. A deferred boot counts as Delivery progress, so a parent waiting on that child is not treated as stalled. The Owner and Moderators are never deferred.

The count can exceed the bound. Concurrent checks can see the same free slot, and resumed waits, interactive input, and a Moderator continuing a dormant responder start child work without a check. Parked Runs keep their processes, so the bound limits model work, not child processes. Pi's native retry and Run Suspension still handle provider rate limits and quota. See [ADR 0007](adr/0007-soft-concurrency-bound.md).

## Pending Message delivery

`maxPendingDeliveriesPerAgent` limits distinct pending Message identities separately for each recipient. Deferred and Steer scheduling share the limit. Same-identity retry coalesces without using another slot.

Each new distinct delivery admission uses the policy snapshot current at that admission. Lowering capacity never evicts admitted Messages. Exhaustion rejects only the new volatile scheduling request with `capacity_exhausted`; the canonical author Message remains available for later explicit retry. An exact-Hold Supervisory Resume Message keeps its separate reserved slot.

## Operation Review interval

`operationReviewIntervalMs` limits one applicable review interval for each unresolved root Pi tool call owned by an answer-obligated Agent. Each call captures the complete policy snapshot current at execution admission, so reload affects only later calls.

Every reviewed call starts its interval at execution admission. A Moderator may renew an exact current call for a positive interval no greater than the value captured by that call. Longer observation therefore requires another deliberate renewal; policy reload never stretches an admitted call's bound.

## Delivery progress interval

`deliveryProgressIntervalMs` bounds a continuous interval during which Delivery machinery is responsible for advancing an eligible Message toward transcript commitment. The default is one minute; ordinary model generation and parked Agent Wait are not part of this interval.

Each observed scheduling admission captures its interval. An eligible delivery starts timing at its first live eligibility observation; reservation and dispatch restart the captured interval. Transcript proof or suppression ends observation. An active recipient, Request admission behind an existing Answer Obligation, Human attention, selection, and Holds suspend applicable delivery timing. Regained eligibility starts a fresh captured interval. Polls, heartbeats, logs, and policy reload do not extend it. A known lost scheduling continuation qualifies immediately instead of waiting for expiry.

The same current policy value bounds one moderation inspection/bootstrap pass, including replacement creation after terminal Moderator failure, before reporting passive Owner attention if that pass does not complete. This watchdog does not abort the pass or retry any effects. See [Operational Incident moderation](operational-incident-moderation.md) for dependency qualification and exclusions.

## Model exclusions

`excludedModels` is a deny list for child and Moderator Runtime preparation. Each entry is one of two forms:

- `<provider>/*` excludes every model of that provider, including models a later catalogue update adds.
- `<provider>/<modelId>` excludes one exact identity. A model id may itself contain slashes, as OpenRouter identities do.

Any other entry — a bare `*`, `*/*`, `gpt*`, `*/flash`, a missing slash, an empty segment, surrounding whitespace, or a duplicate — rejects the complete file, like every other field. Matching is a union of the two forms. There is no negation and no exception syntax, so one model cannot be carved out of a provider entry; exclude the individual models instead.

An excluded model is not selectable from Agent Template candidates and is refused as an explicit `agent_spawn.config.model.id`, reported as `excluded by model policy` rather than a generic availability failure. A Template whose candidates are all excluded is refused by name. Model availability for preparation therefore requires a catalogue entry, configured provider authentication, and absence from this list.

Exclusion applies to selection only. An inherited parent model and the explicit `"inherit"` sentinel are never excluded, so banning the model you are currently using cannot break a spawn whose Template configures no model. Exclusion applies to Runtime preparation, never to a Runtime that already exists: an affected ban takes effect at the next preparation, and a running Agent keeps its current model.

### Owner toggle menu

The Workflow Owner session exposes the list as a toggle menu:

```text
/agents models
```

The menu lists every model the Owner may currently use, plus every stored entry, so any ban stays reversible. Provider rows (`<provider>/*`) sort above their models. A check mark means the model is usable; a dim row is banned; `[unavailable]` marks a banned identity the catalogue no longer offers; a dimmed model row covered by its provider entry can only be changed through that provider row.

`Enter` toggles the selected row. `Ctrl+A` allows every visible row, and `Ctrl+X` bans every visible model row as an exact identity — both scoped to the current search text, and neither ever creates a provider entry. `Escape` closes the menu. Space belongs to the search box, which filters by fuzzy match on provider, model id, and model name.

Every toggle rewrites this file immediately through a temporary file and rename, then republishes one frozen policy snapshot and refreshes cached Agent Template catalogues. A failed write leaves the previous list in effect and reports the failure inside the menu. Stored identities are never pruned automatically: an entry whose model is absent from the current catalogue stays listed and remains reversible.

`/agents models` exists only in the admitted Workflow Owner session. A child Agent's `/agents` command offers only `owner`.
