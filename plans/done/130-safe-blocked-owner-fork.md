# Safe Owner fork after failed coordination admission

## Goal and intention

Implement #130: preserve a blocked Owner's selected native conversation in a fresh independent Workflow, without repairing the source or treating failed validation as Owner authority.

## Scope and constraints

Keep native Pi fork/clone and the existing fresh Owner Identity cutoff. Separate successful Owner role identification from full coordination admission. Child Agents, Moderators, and failures before Owner identification must remain fenced. No compatibility parsing, source transcript mutation, or ordinary coordinator recovery is introduced.

## Failure case and decision

A failed bootstrap may actually be a child or Moderator session, not an Owner. Record Owner identification only after the existing role validator returns successfully; never infer it from an exception. The marker belongs to the current extension attachment and is reset for each bootstrap. A failed bootstrap before this checkpoint refuses fork explicitly. Fork still uses Pi's awaited shutdown path rather than bypassing cleanup.

## Work plan

1. Add native lifecycle regression cases using successful persisted Spawn/Request history invalidated under the current input contract, plus separate role-refusal coverage.
2. Observe red before enabling the role-identified failed-admission fork path.
3. Verify copied context, fresh evidence cutoff/Workflow, no old obligations or child continuation, and unchanged source bytes.
4. Update recovery diagnostics and maintained docs; run bounded targeted suites and typecheck.

## Validation

Use the public native Runtime fork operation and registered coordination tools in `tests/owner-fork.test.ts`. Existing participant and bootstrap tests cover adjoining lifecycle contracts. Do not run the full integration suite.

## Progress

- Inspected admission, Owner Identity adoption, native fork tests, and Pi's session lifecycle/format documentation and cancellation example.
- Existing fork bootstrap already appends the current-session Owner Identity before protocol recovery; no new cutoff record or transcript reconstruction is needed.
- Added successful process-backed Request/Spawn fixtures, invalidated their required titles only after successful receipts and deliveries, then verified cold and reload blockage followed by independent fork/clone admission.
- Red: native fork was cancelled for the blocked Request Owner, and unknown-role fork produced no explicit refusal. Green after the separate Owner-identification checkpoint and conditional fork guard.
- Verified selected conversation equality, fresh current-session Identity, empty child roster/obligations, empty `workflow_resume`, rejected old identities, and byte-identical source Owner/child transcripts.
- Added child and unidentified-role refusal cases; existing matching Moderator cancellation remains passing. Updated diagnostic recovery text and maintained recovery docs.

## Surprises and discoveries

An invalid Spawn source alone quarantines the child rather than blocking the entire Owner. The Spawn variant therefore invalidates both its real successful Spawn and a real successful Owner Request; the Request-only variant isolates ordinary protocol admission failure. This preserves existing quarantine policy.

## Validation outcomes

- `npm run test:process -- --file=owner-fork.test.ts`: 9 passed (including four new cases). The four new cases passed again after adding both native before/at positions.
- `npm run test:fast -- --file=owner-diagnostics-surface.test.ts`: 6 passed; recovery-text assertion was observed red before the text update.
- `npm run test:process -- --file=owner-bootstrap.test.ts --test-name-pattern='invalid committed|resuming an invalid|healthy Owner becoming|a Moderator bootstrap|reload quiesces|an invalid initial Workflow'`: 8 passed.
- `git diff --check`: passed.
- `npm run typecheck`: blocked by pre-existing TS2339 at `src/coordination/message-delivery-scheduler.ts:1164`, referencing absent `ActivePromptDelivery.deliveryCommitted`. Reproduced the identical error against a clean `git archive HEAD` snapshot in a disposable directory using the same installed dependencies. No task-file type errors were reported; unrelated scheduler code was not changed.

## Outcome

Implementation and bounded regression coverage are complete. Parent review confirmed that the checkpoint follows the existing role validator, native replacement retains shutdown, and fresh Identity scopes copied evidence out of recovery. The complete Owner fork file passed again during review. No transcript repair, compatibility parsing, or new protocol cutoff format was added; native fork already establishes the required new Identity cutoff before recovery.
