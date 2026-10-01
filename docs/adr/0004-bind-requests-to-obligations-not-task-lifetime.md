---
status: accepted
---

# Bind Requests to obligations, not to task lifetime

An Agent Request stays open until the recipient commits an explicit Answer, and that Answer is routed back to the requester whatever happens to the Run that was working on it. We keep this pairing instead of adopting the task-lifetime model in `@earendil-works/pi-durable` (1.0.0, 2026-10-01). There, the reply to an input is whatever final answer ends the run it lands in, and the link back to the spawner lasts only as long as the task that submitted it. That model loses the requester in cases this protocol must handle: an Agent that is stopped and later resumed, a human who steps into a child's session, and overlapping senders.

## Considered Options

- **Task-lifetime pairing (`pi-durable` examples).** The upstream subagent patterns ([`experimental/durable/subagent.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/experimental/durable/subagent.ts), [`23-subagent-background.ts`](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)) pair each submission with the final answer of the run it joins, as defined in [`docs/spec.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md). Rejected because:
  - **Stop, then resume:** aborting the child settles the input `unanswered`. The foreground tool throws and the background reporter reports nothing; partial output stays only in the child's transcript. When the owner task is terminal, later work in the child is a top-level node, so a resumed Run reports to no one.
  - **Human intervention:** input typed into the child through `/agents` has no reporter, so the spawner never sees that exchange.
  - **Overlapping senders:** a steered input joins the active run, so several senders share one final answer that may address only one of them. `followUp` restores 1:1 pairing only by serializing, and never across an abort.
- **Rebuild obligations on `pi-durable`.** The building blocks exist: durable documents, owned tasks, and `requestId` deduplication. But this is the same protocol rebuilt on a runtime the Pi CLI does not host. The durable TUI loads no Pi extensions, and Earendil states Pi Durable "does not replace the Pi coding agent".

## Consequences

- **Retire this extension only if Pi itself ships durable subagents** that the requester can reach again after they go idle, that keep the requester link through stop, resume and human intervention, and that run inside the Pi CLI with its extensions and skills. Native subagents alone do not meet that bar.
- **Durability plumbing is not at risk of becoming obsolete.** Earendil plans to bring Pi Durable lessons back into Pi feature by feature, not to migrate Pi onto it.
