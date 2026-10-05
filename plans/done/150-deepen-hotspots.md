# Deepen hot-spot modules (map #150)

## Goal

Implement the 13 ready-for-agent specs from map #150 on one integration branch, `deepen-hotspots-150`, and land them as one PR that closes every spec.

## Intention

Each spec deepens a hot-spot module found by the 2026-10-03 architecture review. Behaviour stays the same unless a spec says otherwise. The spec issue bodies and their comments are the source of truth; this plan only orders and tracks them.

## Scope & Constraints

- Specs: #160 #161 #162 #163 #164 #165 #166 #168 #169 #172 #173 #174 #175.
- Map notes on #150 fix the order. The blocking edges were design gates only, and all of them are closed.
- Every implementer works in its own worktree, `.worktrees/150-<issue>`, on branch `impl/150-<issue>`, cut from the integration tip. Build each ticket with the `tdd` skill.
- Before handoff, the implementer rebases onto the integration tip. The integration branch then takes a fast-forward merge.
- Run focused tests only: `npm run test:fast -- --file=…` and `npm run test:process -- --file=…`, plus `npm run typecheck`. Do not run the full suite until the end.
- Remove superseded code and docs within each spec; add no compatibility paths.

## Work Plan

The tracks avoid file collisions and run concurrently. Within a track, specs run in order.

- **Coordination:** #161 → #160 → #169 → (#174 ∥ #162). #174 and #162 both touch coordinator construction, so whichever lands second rebases on the other.
- **Surfaces:** #175 → #166 → #163 → #164 → #173.
- **Runtime:** #165 → #172 → #168.
- Cross-track overlap: #166 and the Runtime track both lightly touch `child-runtime-bridge.ts`. Protocol version bumps (#165 to v12, possibly #168) are resolved at rebase time.
- After all 13 specs: a `code-review` pass on the integration branch, one fix-up implementer, the full suite, then mark the PR ready.

## Validation

- Per spec: tests written first and seen failing for the expected reason, then focused files green and typecheck clean.
- At the end: the full `npm test` on the integration branch.

## Progress

- [x] Coordination: #161 (done, 052e69c) #160 (done, 1c5cc4b) #169 (done, c0c9f95) #162 (done, eddde7a) #174 (done, 5002a0c)
- [x] Surfaces: #175 (done, 1721bda) #166 (done, 767cc2b) #163 (done, eb9fa12) #164 (done, 44c1a63) #173 (done, 3eaa16a)
- [x] Runtime: #165 (done, 2e441c7) #172 (done, 2320e47) #168 (done, 3f9c86f)
- [x] Code review and fixes: 10 findings, 2 real regressions fixed (94def0c exact commit-proof text, ea33306 starting Moderators out of Owner parking). The rest were spec-required, pre-existing, false positives, or follow-ups (Operational Incident suppression scope; reuse catchUp's result in sync).
- [x] Full suite: everything passes except 4 coordinated-workflow-pty tests. Those come from the environment, not the code: the test hardcodes `../node_modules/.../cli.js`, and `.worktrees/` checkouts have no node_modules. With node_modules symlinked, 12/12 pass at e2cc612, and main fails the same way without it. Follow-up: resolve the CLI through `import.meta.resolve`.
- [x] Round-2 fix-up (8e8a6be identity proof, 593d6a1). Its review found new risks in the identity proof. Matrix: restore main's per-role rule 4.15 vs patch the identity proof 2.3. Round 3 reverts both and restores child exact + Owner prefix (impl/150-review-fixes-3). Identity-based proof becomes a follow-up proposal.
- [ ] /reload PTY test fails intermittently on the branch (2/4, 2/3, and once in the full suite) and passes 4/4 on main. Diagnosis is on impl/150-reload-flake. Every other full-suite test passed at fbe9485.
- [x] Round 3 landed (3b30fba): per-role commit rule, child exact (default), Owner human input leading.
- [x] Round-3 review: no bugs; the commit proof matches main again. Main's remaining gaps are kept: same-text queued Deliveries, short-prefix matches, and a child extension appending to forwarded human input.
- [x] /reload fixed. eba9286 (#172 regression): an Owner event between generations closed the Control channel. Round-1 finding 5 was wrongly triaged as pre-existing. be4efca: a test race that also exists on main (/reload was typed before agent_settled); kept on the branch so the suite gate passes, and stated in the PR. 0/10 failures after both fixes.
- [x] Full suite on a9de832: typecheck and `npm test` pass (exit 0). PR opened.
- [ ] Full suite, PR ready

## Surprises & Discoveries

- #161: the Run Suspension handler in `agent-runtime-host.ts` still passes a Run handle the coordinator no longer uses. Narrowing it is a follow-up, not in scope.
- #160: two spec corrections, posted on the issue. Isolated resumption ranks below Progressing, which keeps the 5d93223 parking fix. Obligation Stall keeps requiring attention `none`, so an Agent Wait parent gets no reminder of its own.
- #175: in tests that run the real Owner, shut down with `host.runtime.dispose()`; `coordinator.shutdown(() => dispose())` deadlocks. `createOwnerExtension` is now a named package export. `registerAgentsCommand`'s non-Owner path is used only by `remote-agent-selector.test.ts`, which #164 should clean up.
- #166 renamed exports: `ParticipantCoordinationRole` is now `CoordinationRole`, and `ParticipantCoordinationToolHandlers` is now `CoordinationToolHandlers`. Schemas live in `src/tools/coordination-tool-catalogue.ts`. The Runtime track must rebase onto these names. A receipt renderer now runs only for final, non-error results.
- #165 confirmed the bug and fixed it with a test: the child commit proof rejected Pi-normalized image input. Protocol is now v12. `agent.end` carries `failure`, and `agent.settled` loses `outcome`. The turn admission hook is per Delivery (`{ admit, submit?, accepted? }`). Literal protocol versions live in three test files. `test:fast` rejects process-suite files.
- #160: interactive selection also ranks below Progressing (bc3af9c/1c5cc4b, with a parking test). The final order is Inactive → Waiting (human input, Hold, suspension) → Progressing → Waiting (selection, isolated resumption) → Stalled. Each parking or reminder check now builds a full snapshot, which is a possible perf follow-up.
- #163: Owner tools now turn off at Pending inside the guarded block, so the turn hold always settles. Fakes of the bootstrap procedure must report "Owner identified" before returning a view. `src/index.ts` keeps an inherent cycle between Owner tools, the presenter and the admission object.
- #164: a blocked Owner offers only `diagnostics`, and arguments are validated before the headless check. A failed physical attachment still does not roll back the selection; that predates #164 and is a possible follow-up. `--file=` takes one file per run.
- #173: `AgentSelectorAction` and the Owner lookup moved to `src/presentation/agent-selector-projection.ts`. `docs/agent-view-acceptance.md` still says to use `node --test`, which predates this work and is a doc follow-up.
- #169: `subscribeWaitPreemption` allows one subscriber. `reconfirm` throws an invariant violation if an Answer stops being canonical between retrieval and commit. The scheduler's `hasDispatchReservation` is private; the shared query is `isDirectDeliveryInFlight`.
- Regression: `run-supervision.test.ts` passes on main (ab22078) but fails and then hangs at c0c9f95. It is being bisected on `impl/150-run-supervision`.
- #172: the proxy takes a projection factory, so child exit is observed before the terminal reports it. The in-memory transport is synchronous, so a few loopback tests wait one `setImmediate`. Possible hang: if `proxy.dispose()` runs while a Run is still active and the supervisor discard comes after it, `waitForIdle` waits forever. It has only been seen through test ordering.
- #174 landed (5002a0c). Known gap: when the requester is absent, `stakeIn`'s recovery branch still uses `findLocalAnswer`, which reads admitted Answers. It was moved unchanged. The queue now advances only when the owed set shrinks. The admitted-authorship overlay feeds every projection query.
- #168 landed (3f9c86f). Pi allows a null `branchSummary.fromId`; the old schema rejected it (fixed in 5e6df49). Owner-side serve map installed in the broker `configure` callback. `addChangeHandler` is now required.
- run-supervision regression: caused by #165, fixed in fab6adf. The Native Session Driver now settles the commit proof false at the Delivery's own message end; waiting for the whole Run deadlocked against the Agent lane.
- #162: the construction order is documented in `docs/development.md`. #174 adds Request evidence → Request Relationships at the front. `subscribeRuntimeQuit` allows one subscriber, so there is one Interactive Selection per factory. Operational Incident detection self-subscribes.

## Decisions

- Implementers rebase and the integration branch fast-forwards, instead of merging the integration tip into each implementer branch. The user's git preference wins over the skill default.
- The draft PR waits for the user's go-ahead, because their rule is not to push unless asked. Work stays local until then.
- No separate exploration pass: each spec body already names its files and seams.

## Outcomes & Retrospective

- All 13 specs landed on one branch. Integration surfaced 5 regressions that per-spec focused tests missed. 2 of them showed up only in the full suite or the real-CLI PTY tests (#165's deadlock and #172's reload channel close).
- Review triage needs evidence. Round-1 finding 5 was triaged as "pre-existing" but turned out to be the #172 reload regression.
- Redesigning during review (the identity commit proof) added risk. For a behaviour-preserving PR, restoring main's semantics was the better call.
- `.worktrees/` checkouts need `node_modules` for the PTY tests. Follow-up: resolve the CLI through `import.meta.resolve`.
