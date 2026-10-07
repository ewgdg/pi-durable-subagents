---
status: accepted
---

# No provider quota classification

Every unexpected terminal error from a still-usable Runtime suspends the Run as `runtime_error`. We remove the `provider_quota` suspension reason, its classifier, and its "Usage limit reached" label with the reset time. Quota detection cannot be reliable: each provider reports exhausted quota differently, and Pi's `AssistantMessage.errorMessage` keeps only formatted text, where the HTTP formatter merges quota, throttling, and other 429 responses. The classifier therefore matched a few exact codes and one Codex diagnostic, and every other provider already fell through to `runtime_error`. Both reasons shared one contract (hold, resume, incident and reminder quieting), so quota added only a label and a reset time that only Codex/OpenAI supplied. The provider's error text stays in the transcript and in the suspension evidence, so a human still sees why the Run stopped.

## Considered Options

- **Keep quota classification as a best-effort label.** Rejected: a misleading or missing label is worse than a uniform one, and each new provider code means more string matching against formatted text.
- **Fail the Run instead of suspending it.** Rejected: Run Failure ends the Run and turns its waiting Requests into failures, losing the resume path for a condition a human can fix.
- **Remove the `reason` field.** Rejected: it would break the status shape for no gain, and the field still names the stop.

## Consequences

- A quota stop displays as **Suspended · Runtime error**, with the provider's error text as evidence. Temporary throttling still uses Pi's native retry.
- `run.suspension.reason` is always `runtime_error`. Suspension is process-local and never persisted, so no stored `provider_quota` state needs migrating, and the Control protocol version is unchanged because Owner and child come from the same installed package.
- If Pi later preserves structured provider error codes and reset times, a quota reason can return on that evidence instead of on formatted text.
