# Admit children by selected-tool availability, not startup activation

## Goal and intention

Trigger: runtime report FO8C. A child spawned with an `openai-codex` model failed Run 1 with `child_runtime_tools_mismatch` because an inherited extension rewired its tool surface during `session_start`. `@howaboua/pi-codex-conversion` runs code mode for codex models (`executionMode: "code"`): `read`, `bash`, `edit`, `write` (its default tool names) and `web_run`, `imagegen` (its code-mode extension tools) stayed registered in the child but were deactivated, so the old "active tools must equal the selection" rule refused the Run. Reproduction: two codex-model Spawns in the source session and one probe Spawn in this Session failed identically; the same Spawn with an inherited non-codex model started.

Intention: make the startup contract about **availability** — every selected tool must exist in the child's tool registry — while activation stays the child's own business, exactly like activation changes after admission already are. Inheritance rules stay unchanged: a child inherits the parent's **active** tools, never its registered catalogue.

## Scope and constraints

- Runtime snapshots gain `registeredTools` (the child's tool registry) as admission evidence; the control protocol version bumps so a stale installed package is rejected by the launch-contract guard instead of failing mid-startup.
- `registeredTools` must never feed descendant inheritance, working-zone preparation, or any other configuration resolution. Inheritance reads active `tools` only.
- Keep role normalization of the selection, execution-mode consistency, skill, extension, system-prompt, and trust checks unchanged.
- Do not require any particular active set at admission, and do not add a participation guarantee for coordination tools here; that is a separate decision.

## Work plan

1. Protocol: add `registeredTools` to `RuntimeSnapshotSchema`, bump `AGENT_CONTROL_PROTOCOL_VERSION`, and state what the version made incompatible.
2. Child bridge reports the registry (`session.getAllTools()`); host shape asserts the new member.
3. Host admission: fail only on selected tools the child cannot provide; the failure names unavailable, inactive, and active tools.
4. Tests: unit availability semantics, real-process variants (inactive and extra active tools admitted, unavailable tool rejected), startup-dialog outcome, owner-only probe expectation, snapshot fixtures, protocol-version literals.
5. Docs: rewrite the startup-selection paragraph in `docs/agent-spawning.md`.
6. Typecheck plus focused fast/process suites; commit at the protocol and admission boundaries.

## Validation

Focused process tests own the behavior: `pi-child-process-runtime.test.ts` (unit semantics plus a real child whose inherited extension deactivates a selected tool) and `pi-child-process-launch.test.ts` (admission after startup dialogs). `agent-spawn.test.ts` keeps the Owner-only-tool rejection as the unavailable case. The full suite is not run unless the change looks finished.

## Progress

- [x] Diagnosis and live reproduction recorded (journal 2026-09-16, report FO8C).
- [x] ExecPlan written before implementation.
- [x] Protocol and child bridge report registered tools.
- [x] Admission uses availability; tests and docs updated.

## Decisions and discoveries

- The child's active set is still reported (`tools`) and remains the only inheritance source; availability is an additional fact, not a replacement.
- Extra active tools were already tolerated only after admission; availability semantics makes startup match that behavior.
- The old failure text printed the diff only, which made a nine-tool active surface look like a two-tool one. The new text lists unavailable, inactive, and active tools.

## Outcomes and retrospective

One commit carries the whole change: the registry field only matters together
with the admission rule, so splitting them would leave a snapshot field without a
reader. Verified with `npm run typecheck`, the tool-contract process tests
(`pi-child-process-runtime`, `pi-child-process-launch`, `agent-spawn`), the
protocol and version tests, the hosted-runtime fixtures, and the conformance
`host-shape` and `host-module-world` files. The codex-adapter case is covered by
the "rewired" process variant, which deactivates a selected tool and activates an
extension tool of its own during the same startup.

Pre-existing environment failures, reproduced on a clean tree and unrelated to
this change: two cases in `pi-child-process-runtime` (Run intention
`executionStarted`), three in `agent-spawn` (real child turns), and one in
`child-launch-contract-containment` (preflight rejection reported as an ended
Run).

Two follow-ups stay open: whether the host should also require the child's role
coordination tools to be active at admission (an extension could now leave them
registered but inactive), and whether the tolerated activation delta should be
recorded as a Run diagnostic instead of only living in the snapshot.
