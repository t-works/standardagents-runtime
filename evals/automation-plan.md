# Automating `08-no-client-required.json`

Decisions taken for the six cases that need no HTTP or WebSocket client. Built on 2026-11-22: the
six cases run in `evals/08-no-client-required.json` and `npm run check` / `npm run evals` cover
them. Order matters: the harness readers are shared, the fixtures are not.

## Where the build differs from the plan

- `api-09` was built in that order: `fixtures-broken/hook-user-scoped/` and its case first, observed
  red (`load.issues: expected {"length":1} got []`), then the loader check. The check is a second
  branch in the same `parentHooks` loop with its own message, not one shared condition, so the two
  cases assert different text (`is not available` vs `user-scoped`).
- `api-08` needs no `drop_image` tool: the case queues the PNG as inline `{name, mimeType, data}`,
  which the runtime materializes into the thread filesystem. Same two surfaces, one fixture less.
- `api-06` queues both messages with `"trigger": false` (the harness passes it to `queueMessage`),
  so nothing drains them before the restart. The busy-thread alternative races with a live run in
  the old Runtime.
- `scripted_dual` wraps `scripted` instead of copying it. It logs the provider rows as
  `{side, messages: [{role, content, toolCalls}]}` under `model.views`; message ids do not survive
  into the provider request, so they are not in the log.
- `api-11` asserts `model.views` for the side-B call and for side A's second call; the side-B view
  ending at two rows is what proves the opposite side's tool call is invisible.

## Decisions

| Case | Decision |
|---|---|
| `api-06-eviction` (S9-2, SHOULD) | Automate **durability only**: queue entries survive a restart and stay ordered. No resume claim — §9 says "if idle: queue and force the next turn" but is silent on how an evicted object wakes, so a case that asserted self-resume would over-specify. |
| `api-08-attachment-parts` (S4-6, MUST) | Automate: new `fixtures/models/scripted_vision.ts` (declares `capabilities.supportsImages`, logs request `parts`), new `drop_image` tool, new `messages.attachments` assertion kind. |
| `api-09-parent-hook-fail-closed` (S7.3.1-1, MUST) | Two automated cases over a sibling `fixtures-broken/` tree: required hook id that does not exist (green today) and required user-scope hook (**red** today, `factory/bugs/parent-hook-user-scope-skipped.md`). |
| `api-10-sandbox-documentation` (S14.4-2, S14.4-3) | Stays manual: reading documentation is not observable in a run. It has an answer now — the "This runtime" section of `../rules/ADRs/code-execution-resource-limits-and-termination.md` states the 64 MiB default, the 2 GiB ceiling and the clamp behaviour. |
| `api-11-perspective-mapping` (S4-5, MUST) | Automate: new `fixtures/models/scripted_dual.ts` logging raw per-message `{ id, role, side, toolCalls }` **and** a derived `view` array; new dual-prompt agent with no subagents. |
| `api-12-session-turn-cap` (S6-1, MUST) | Automate on the same dual-prompt fixture: assert `model.calls`, `status: idle`, `terminated: null`; cite `S10-2` as well as `S6-1`. |

Shared fixture for `api-11`/`api-12`: both sides prompt-backed, both `stopOnResponse: false`,
`maxSteps: 1`, `maxSessionTurns: 4`, no subagents of its own. The turn cap ends the session, which
gives two full alternations and a deterministic request sequence.

## Harness deltas (`run.mjs` + `check.mjs`)

| Delta | Needed by | Shape |
|---|---|---|
| `restart` op | `api-06` | new `Runtime({store, registry})` over the same store dir, `runtime.threadFor(store.load(id))`; rewires `state.thread` |
| `queue` reader | `api-06` | `store.loadQueue(id)` entries minus volatile fields, keeping `id` so two queued messages stay distinguishable |
| `load` case field | `api-09` | path relative to the eval dir, loaded with `loadSource` for that case only |
| `load.issues` reader | `api-09` | the loader's `DefinitionIssue[]`, so a case asserts `severity: error` + message |
| `messages.attachments` reader | `api-08` | per-message attachment refs from persisted history |

`check.mjs` needs the new kinds in `KINDS` and the new key in `OPS`/assertion fields, and its
"automated case needs ops/expect" rule then applies to the six promoted cases.

## Fixture deltas

- `fixtures/models/scripted_vision.ts`, `fixtures/models/scripted_dual.ts` — separate files so the 40
  existing cases' logs stay byte-identical.
- `fixtures/tools/drop_image.ts` — writes a 1x1 PNG as `image/png` into the thread filesystem.
- A dual-prompt agent and its two prompts.
- `fixtures-broken/hook-missing/`, `fixtures-broken/hook-user-scoped/` — deliberately broken packages,
  never loaded at startup (`run.mjs:57-60` exits on errors from `fixtures/`).

## `requirements.json`

`coverage` must flip `manual → automated` for `S9-2`, `S4-5`, `S4-6`, or the file claims those are
manual while automated cases cite them. `check.mjs` will not catch it: `cited` counts automated cases
too (`check.mjs:91-97`), so both gates stay green with stale coverage. Do it by hand.

After the pass the manual count drops from 12 to 7 (`api-01…05`, `api-07`, `api-10`).

## Risks

- `model.calls` counts child turns when the provider is cached per model name (README caveat), so the
  dual-prompt fixture agent must declare no subagents or `api-12`'s count is polluted.
- `scripted_vision`'s `parts` logging must serialize only JSON-safe content; a raw `{type: 'image',
  data: base64}` is fine, a `Buffer` is not.
- The user-scope case was red until `loader.ts:200` also rejects the user-scope names. It is fixed
  now (`factory/bugs/parent-hook-user-scope-skipped.md`), and the case is the check that fails if
  the check is removed; do not weaken it to a manual note.
