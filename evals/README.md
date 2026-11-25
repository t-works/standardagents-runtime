# Baseline agent evals

Minimal Standard Agent fixtures plus declarative eval cases that probe the MUST/SHOULD clauses in
[`spec/standard-agents-runtime-specs.md`](spec/standard-agents-runtime-specs.md).

This is a copy of `factory/evals/baseline-agent-evals` from `standard-agent-runner`, made runnable
inside the runtime repository: `run.mjs` imports `../runtime.ts` and friends (the source under test,
no install and no build), the suites live in `suites/`, and the spec is vendored at `spec/`.

```
node evals/check.mjs        # structural gate: requirements, coverage, references. No install needed.
node evals/run.mjs          # execute the cases against this repository's runtime (scripted model)
node evals/run.mjs --model deepseek-chat   # same cases over a live provider (see below)
```

`check.mjs` fails when a MUST/SHOULD has no automated case, a manual requirement has no manual
case, a case cites an unknown requirement, an op/assertion kind is unknown, a referenced agent or
tool file is missing, or a requirement cites a section the spec does not have.

`run.mjs` is the executor: one fresh thread store per case, `ops` become `Runtime`/`Thread` calls,
`expect` entries read the observation surfaces below. It writes `results/runs/<id>.json`, keeps the
thread store of every failing case next to it, and compares against `results/baseline.json` when
there is one (`--against <file>` to pick another, `--baseline` to accept the current run). Statuses:
`pass`, `fail`, `error`, `not-implemented` (the runtime throws on purpose, e.g. `runCode`),
`manual` (never run).

```
node evals/run.mjs --suite 04 --case sub-07-attachments-parent-to-child   # one case
node evals/run.mjs --baseline                                            # accept a new baseline
node evals/run.mjs --against evals/results/runs/<id>.json                 # compare two runs
```

## A live model

`--model <id>` (with `--provider deepseek|openrouter`, default `deepseek`) points every prompt at one
real provider instead of the scripted stand-in; `evals/run.mjs` records it as `run.model`. The live
model records the provider-level surfaces the scripted fixtures write — `model.calls`,
`model.requestLog` (including `parts`) and `model.views` — so a live run is judged on what the
runtime handed the provider, not on bookkeeping the live path never wrote.

It stays a smoke test, not the conformance gate, because the cases assert turns the scripted model
emits exactly: `[[once]]`/`[[tool:…]]` directives, one call per turn. Measured 2026-11-24 with
`deepseek-chat`: **38 pass, 20 fail**. Every remaining failure is the model's own choice — an extra
turn (`model.calls` 3 where 2 were expected), two tool calls split over two turns instead of one
(`exec-02`), a `subagent_create` given the name the case omits on purpose (`sub-03`), or later
`[[tool:run_code …]]` directives skipped (`code-02`-`code-06`). No failure is a missing observation
surface.

Provider instances are cached per model name, exactly as the scripted fixtures are, so a `model.*`
value on a thread with children can include a child turn.

Each model keeps its own baseline, so the two never judge each other: `--baseline` writes
`results/baseline.json` for a scripted run and `results/baseline-<model>.json` for a live one, and a
run only compares against its own model's file. Comparing across models is refused with exit 2
rather than reported as regressions.

## Human pages

```
node evals/docs/build.mjs                      # index.html + results.html
node evals/docs/build.mjs --results <run.json> # render another run

node evals/docs/run-report.mjs                 # one run page from the newest run file
node evals/docs/run-report.mjs <run.json>      # or a specific run
node evals/docs/run-report.mjs --help          # all options
```

- `evals/docs/index.html` — the requirement view: every case collapsed to its id and *why*,
  expandable to the quoted requirement text and the spec section it comes from, then the
  ops/assertions that exercise it.
- `evals/docs/results.html` — one run: `evals/results/baseline.json` when one exists, otherwise the
  newest file in `evals/results/runs/`. Each case shows its status and every assertion with the
  value it expected and got; a failing case also carries the tail of its runtime events.
- `evals/docs/evalYY-MM-DD_mm.html` — one run from `run-report.mjs`, dated from the run. Files and
  cases are expandable; a case shows its verdict, why it failed (expected vs. actual), and the
  turns/messages the run recorded for it. `run.mjs` keeps `events` only for non-passing cases, so
  passing cases show assertions without a turn log. The page defaults to the newest run file and
  can be pointed at any other run with a positional path or `--run`; `--out` changes the page path.
- The run's `model` field (`scripted` or a live `--model` id) is in the header, so a live smoke run
  is not mistaken for the conformance gate.
- All pages are generated: rerun the script, do not hand-edit.

## Layout

| Path | What it is |
|------|------------|
| `fixtures/` | Loadable Standard Agent package (`agents/`, `prompts/`, `tools/`, `models/`, `hooks/`, `handlers/`, `effects/`) |
| `fixtures-broken/` | Packages that must fail to load; only read through a case's `load` field |
| `suites/*.json` | Declarative cases, grouped by spec area |
| `spec/` | Vendored spec the requirement ids point at |
| `requirements.json` | One entry per normative clause: id, spec section, force, coverage |
| `check.mjs` | The gate described above |

Load the fixtures with any Standard Agent runtime:

```
node cli.ts run evals/fixtures -a probe
```

The prompt-backed sides use the `scripted` model, so no provider key or network is needed. With the
reference runner at `factory/reference/standard-spec-runner`, any non-empty `OPENAI_API_KEY` and the
`node_modules` in this folder (see `package.json`) are enough.

## Case format

```json
{
  "id": "exec-01-step-cycle",
  "agent": "probe",
  "requirements": ["S3-1", "S5.1-1"],
  "why": "one line: what this proves",
  "env": { "OPTIONAL_LEAF": "yes" },
  "ops": [{ "send": "[[once]][[tool:record {\"value\":\"a\"}]]" }],
  "expect": [{ "kind": "tools.order", "equals": ["record"] }]
}
```

A manual case sets `"automated": false` and carries a `manual` description instead of ops/expect
(a suite-level `"automated": false` does the same).

A case that loads a package other than `fixtures/` sets `"load": "<path relative to this folder>"`
and asserts on `load.issues`; it needs no ops, and the fixtures registry is never touched.

### Ops

| Op | Meaning |
|----|---------|
| `createThread` | Create the thread without sending; use with `settle` for creation-time behaviour |
| `send` | Deliver a user message and settle, unless `"async": true` |
| `queueMessage` | `queueMessage()` with `{role, content, silent?, attachments?}`; `"trigger": false` queues without starting a turn |
| `queueTool` | `queueTool({name, args})` |
| `injectMessage` | `state.injectMessage()` from outside a turn |
| `scheduleEffect` | `{name, args?, delay?}`; then `settle` |
| `terminate` | `thread.terminate()` |
| `expectRejected` | The next operation of `{op, value}` must reject; asserted with `rejected` |
| `sleep` | `{ms}` wall-clock pause |
| `settle` | Wait until every thread in the case is idle, with a timeout |
| `restart` | Drop the Runtime and rehydrate the thread from the same store, as a new process would |

### Observation surfaces

`thread` on an assertion addresses the parent (default) or `"child:<relationship>"` (first instance
of that relationship). Thread-scoped readings come from the thread itself:

| Surface | Written by |
|---------|-----------|
| `messages` | persisted history |
| `messages.attachments` | `attachments` of every persisted message, flattened |
| `queue` | the durable queue as the store holds it, in order |
| `tools.*` | persisted tool result messages |
| `status`, `terminated`, `children` | thread record |
| `values` | durable KV (`getValue`) |
| `hooks.order` | `hooks.log`: `{hook, id}` per invocation |
| `model.requests`, `model.calls` | `model.requestLog` / `model.calls` |
| `model.views` | `scripted_dual`: `{side, messages}` per call, as the provider saw them |
| `code` | `runCode.log`: one `CodeExecutionResult` per call |
| `effects` | `effects.log`: `{effect, at}` |
| `rejected` | the harness's `expectRejected` result |
| `system.current` | rendered system message from `after_system_message` |
| `load.issues` | the loader's `DefinitionIssue[]` for the case's `load` path |

`model.requests` fields: `user` (newest user text), `users` (all user texts), `system`,
`roles`, `tools` (names), `toolDetail` (full tool list JSON). `index` may be negative to count
from the last request.

Assertion kinds: `messages.roles`, `messages.contents`, `messages.contains`,
`messages.attachments`, `tools.order`, `tools.args`, `tools.status`, `tools.results`,
`tools.maxConcurrent`, `model.calls`, `model.requests`, `model.views`, `values`, `status`,
`terminated`, `children`, `queue`, `hooks.order`, `code`, `effects`, `rejected`, `load.issues`.
Comparison keys: `equals`, `notEquals`, `contains`, `notContains`, `oneOf`, `atLeast`, `length`.

- `contains` / `notContains` on a string is substring; on an array it means every listed item is
  present in some element. `messages.contents` treats `contains` as an ordered subsequence.
- `messages.contains` looks at message `content` only, never `tool_calls`.
- `values` without `field` is a deep equality on the whole KV snapshot; with `field` it compares
  that one value (string `contains` allowed).
- `status` compares the run state only (`idle`, `running`, ...), not its reason.
- `children` `contains` matches each partial object against a registry entry.
- `code` `equals` is a partial deep match on the result; `field` + `contains` reads a nested path.
- `model.calls` treats a missing counter as 0.
- `queue`, `values` and `model.views` take `equals` as a partial match, so an entry is asserted by
  the fields that matter and the order of an array is still checked.
- `load.issues` takes `index` (and negative indexes) like `model.requests`; `field` reaches
  `severity`, `message`, `code`, `path`.

## Scripted model

`[[tool:name {"arg":1}]]` in the newest user message becomes a tool call, in order.
`[[once]]` anywhere in that message makes the directives play only on the first turn; without it
they replay every turn (used by the maxSteps case). Balanced-brace parsing means nested JSON
arguments work.

The model also records, per turn: `model.requestLog` and `model.calls`. Provider instances are
expected to be bound to a thread. The reference runner caches one provider per model name, so on
threads with children its `model.*` values can include a child turn; the cases that run on child
threads therefore assert only thread-local surfaces (`values`, `tools.results`,
`system.current`).

Two variants exist for probes the baseline model cannot serve, kept in their own files so the other
cases' logs stay unchanged: `scripted_vision` declares `capabilities.supportsImages` and records the
newest user content as `parts`; `scripted_dual` wraps `scripted` and records each call's provider
rows as `model.views`.

## What is not automated

`requirements.json` marks each entry `automated` (default), `manual`, `optional` (a MAY), or
`conditional` (engine-dependent). Manual cases live in two files:

- `suites/07-client-api-and-streams.json` — HTTP routes and auth, WebSocket frames, reasoning frames,
  deletion cascade, bootstrap endpoints, runtime streams. They need a running runtime with an HTTP
  or WebSocket client, which the reference runtime does not expose yet; the file is manual as a whole.
- `suites/08-no-client-required.json` — everything here that does not need a transport is automated:
  eviction durability over a store restart (`api-06`), multimodal attachments against
  `scripted_vision` (`api-08`), parent-hook fail-closed over two `fixtures-broken/` packages
  (`api-09`), perspective mapping and the session turn cap over `scripted_dual` (`api-11`,
  `api-12`). `api-10` stays manual: reading documentation is not observable in a run. Its
  subject is the "This runtime" section of the code-execution resource-limits and termination ADR in
  `standard-agent-runner`; the ADR itself is not vendored here.
  The decisions behind the automated ones are in [`automation-plan.md`](automation-plan.md).

Cases the declarative format cannot express yet: real concurrency timing for `exec-05` and the
queue suite (an `async` send does return early — `term-01` and `code-16` drive async send, then a
terminate or a `sleep`, then `settle` — but nothing can assert that two pieces of work overlapped)
and termination of an in-flight tool (`term-01`).
`run.mjs` drives them anyway; the ones that cannot pass today report as `not-implemented`
rather than `fail`.

State in this repository on 2026-11-24 (`run.mjs` output): the full automated set passes —
`pass 58  fail 0  error 0  not-implemented 0  manual 7` in 7.9 s. The same set over
`--model deepseek-chat` gives `pass 28  fail 30`: 14 of the failing cases fail only on `model.*`
assertions the scripted fixture would write, and the rest are the model's own turn and tool-call
choices (extra `subagent_create` calls, a different probe body in `code-04`, a skipped second `kv`
step). Treat that run as a provider smoke test only.

## Spec quirks

- Section number `14` appears twice in the spec (Code Execution Runtime, Durable Key-Value Store).
  KV requirements use the `S14K-` prefix and section `14`.
- Section 16 links code execution as `#13-code-execution-runtime`, which points at the wrong
  section number. Requirements cite `14.1`-`14.9` instead.
- The checklist in section 14.9 is mapped onto the detailed requirements via their `checklist`
  field (1 = `S14.9-1`, 11 = `S14.9-11`, the rest reuse 14.1-14.6 ids).
