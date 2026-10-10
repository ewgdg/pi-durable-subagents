# Virtual Model config in the `/agents` Config tab

Issue: #224. Parent: #213 (Config tab for all settings). Builds on #216 (Virtual Models) and #220 (sticky model selection).

## Goal

The Owner can list, add, edit, and delete Virtual Models from a Config tab in the `/agents` selector, without editing `<agentDir>/config/pi-durable-subagents.json` by hand.

## Intention

User's words: "i want it to support add/delete/edit". Deleting a name that is in use is not blocked: "do not block, just let it fail, with model unavail". After spawn, `virtual/<name>` counts as a model like any real one, so a deleted name is just an unavailable model. Excluded models are not blocked in the picker: "do not let /agents models block it for now, maybe just a marker".

This is the first section of the #213 Config tab. It ships only Virtual Models. Other sections (Templates, Workflow Policy, model deny list) come later and are not designed here.

## Design

- **Entry point** (user decision: `c`).
  - The admitted Owner's selector shows `| Config [c]` right after the last visible cycled tab (`Live  Dormant  Reports | Config [c]`), as in the #213 sketch. It is not part of the Tab / Shift-Tab cycle; the `|` marks that.
  - `c` or a click on the label opens Config. The selector's letter keys (`m`, `o`, `h`, `l`, `j`, `k`) would break text input inside the selector, so Config is a separate overlay. The selector closes with an "open config" result, the command opens the Config surface, and `Esc` from its top view reopens the selector.
  - Child Agents and a blocked Owner show no Config label, as with `/agents models`. A child's selector reads the Owner over Control, and Config has no reason to cross it.
- **Views** (user decision: structured TUI, not JSON in an editor). One `ui.custom` overlay component with a small view state machine:
  - **List**: one row per name with its entries inline as short ids without the provider (`fast  gpt-6.1-luna • high → deepseek-flash • max`), ending in `+N` when the row is full, then `+ New virtual model`. A name with unusable entries carries one `[N unusable]` marker. Detail lines under the list show the focused name's full ids. `Enter` opens a name, `d` deletes it after an inline `d` again / `Esc` confirmation.
  - **Definition**: entries in order, then `+ Add entry`. Unusable entries carry a marker (`[excluded]`, `[unavailable]`), using the same usability rule as routing.
    - `Enter` edits an entry: model picker with the current model focused, then thinking picker with the current level focused.
    - `a` (or `Enter` on `+ Add entry`) appends an entry through the same two pickers.
    - `d` deletes an entry. On the last entry it is refused with "Delete the virtual model instead", since an empty list is invalid.
    - `K` / `J` move the focused entry up or down.
    - `r` renames through a name input. A rename is a delete plus an add, so users of the old name see an unavailable model.
  - **Name input** (pi-tui `Input`, focus passed through per Pi's `docs/tui.md`): validates kebab-case and uniqueness while typing, before it can submit. A new name goes on to the pickers and is written only with its first entry.
  - **Model picker**: fuzzy list over the Owner's available models, the same source and filter as `/agents models`. Excluded models are dimmed with `[excluded]` but selectable. Models already in the list are marked `[in list]` and refused, since ids must be unique.
  - **Thinking picker**: all of `RUNTIME_THINKING_LEVELS`, current level focused. Pi clamps the level to the routed model at request time, so no per-model filtering.
  - An invalid policy file makes the whole tab read-only with the parse error shown, as `/agents models` refuses to rewrite an invalid file. The list still shows the Owner's last valid definitions, dimmed.
- **Saving** (user decision: per action). Every completed action writes immediately, like the `/agents models` toggles. Each action is shaped so the file is valid after it (a new name always has one entry, the last entry cannot be deleted). Running Agents see each step on their next routed request. While a write runs, input is blocked and the status line shows `Saving…` or the error, as in `/agents models`.
- **Write path**:
  - One private field rewrite in `src/policy/workflow-policy.ts` (re-read the file, refuse an invalid file, set or delete one field, re-parse the result, write a temp file and rename), behind two typed writers: `writeExcludedModels` and `writeVirtualModels`.
  - `WorkflowCoordinator.setVirtualModels(definitions)` writes and publishes the policy snapshot. The `/agents` command then syncs the Owner's `VirtualModelRegistrar` (passed in as `syncVirtualModels`), so the Owner's `/model` list follows at once instead of after reload. Child processes keep their registrations and follow through `route()`, which rereads the file on every request.
  - Template catalogues need no refresh: Runtime Preparation rereads Virtual Models before every prepare.
- **Deleting a name in use** needs no special code:
  - A spawn that names it fails with the existing unavailable-model error.
  - A fresh Runtime whose recorded selection names it falls back to its initial values (#220), which fail the same way if they name it too.
  - A running child's router throws on its next request because the name is gone. The Owner, after registrar sync, gets Pi's "Virtual model virtual/<name> is not registered." on its next request (see Surprises).

## Scope & Constraints

- Only `virtualModels`. `excludedModels` stays on `/agents models`. Whether Config replaces that command is #213's question.
- No `/agents config` subcommand. #213 asks for the tab entry only.
- No new settings, no draft or undo state.
- Regenerate the README selector screenshot, since the tab row changes (`node docs/images/agent-switcher.capture.ts`).

## Work Plan

Grow in layers. Each layer works on its own.

### Layer 1: read-only Config tab

- `Config` label, `c` key, and click in the Owner selector. Selector result → Config surface → `Esc` back to the selector.
- List view of current definitions with usability markers. Invalid file shows the error.

### Layer 2: delete and edit existing definitions

- Generic policy field writer replacing `writeExcludedModels`. `setVirtualModels` on the coordinator, exposed to the command through the view, including registrar sync.
- Delete a name, delete an entry, reorder, change thinking.

### Layer 3: model picker and new names

- Model picker: pi-tui `SelectList` rebuilt from `fuzzyFilter` on each keystroke (its own filter is prefix-only), so no list code is copied from `model-policy-surface.ts`.
- Add entry, change an entry's model, new name, rename.

### Layer 4: docs

- `docs/agent-selector.md` (Config tab, `c`, Owner only), `docs/workflow-policy.md` (editing through Config, names added or removed there apply to the Owner's `/model` list at once), README feature line and screenshot.

## Validation

- `npm run typecheck`. Focused `npm run test:fast -- --file=<name>.test.ts` for the selector surface, policy writer, coordinator, and the new Config surface.
- Independent blind tests from the issue text and public interfaces, then an independent review.

## Progress

- [x] Investigation and design (user chose per-action saves, structured TUI, `c` key, no block on deleting a name in use, excluded models selectable with a marker, lists kept, inline `| Config [c]`).
- [x] HTML mockup of all views reviewed with the user.
- [x] Layer 1: Config label, `c`, click, and the read-only list (typecheck and existing selector tests pass).
- [x] Layer 2 and Layer 3, landed together: every edit flow walked through in a throwaway render script (new name, invalid and duplicate names, picker search and `[in list]` refusal, thinking, append, move, rename, delete with confirmation, last-entry refusal, failed save, read-only file). Typecheck and focused policy, virtual-model, command, and selector tests pass.
- [ ] Layer 4
- [ ] Independent tests and review

## Decisions

- Per-action saves over draft + save: matches `/agents models`, and every step can be kept valid. Cost: Agents may route through intermediate lists during a multi-step edit, which is harmless because each step is a valid definition.
- Structured TUI over JSON in an editor: picking ids from the catalogue prevents typos. Weighted score 3.75 vs 3.4 (typo safety 35%, simplicity 30%, fit for later Config sections 20%, testability 15%).
- Separate overlay instead of rendering inside the selector: keeps the selector's letter keys and the text inputs apart, and keeps the selector projection unchanged apart from the label.
- Keep ordered lists rather than one-to-one aliases: #218 (fallback on provider failure) needs the list, and the file format already has lists, so a one-entry editor would leave file-defined lists uneditable.
- Config label inline after the tabs with a `|` separator (user's #213 sketch) rather than right-aligned. Its position shifts when Reports or Quarantined appear; the click region follows it.
- Change an entry's model in place (`Enter` runs both pickers) instead of making the user add, move, and delete.

## Surprises & Discoveries

- `Input.setValue` keeps the cursor at the start, so a rename typed before the old name. The surface inserts the current name as a bracketed paste instead, which leaves the cursor at the end.
- `SelectList` cuts labels at 32 columns by default; the picker widens its primary column for long OpenRouter ids.

- Pi on unregister (`agent-session.js` `_refreshCurrentModelFromRegistry`, `model-runtime.js` `resolveModel`): a session whose current model is an unregistered virtual model keeps the stale model object, and its next request fails with "Virtual model <provider>/<id> is not registered." No crash. On resume, Pi falls back to the physical model that answered last.

## Outcomes & Retrospective

(Filled at completion.)
