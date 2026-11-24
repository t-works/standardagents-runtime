# @t-works/standardagents-runtime

## Why it exists?
I created it as my workflow executor. 
Standard agents concept seems to be a good way to maintain well-structured and flexible workflows. 
My project workflows are part of a bigger thing and need to run in restricted environments, 3-rd party dependency or network connection is a non-starter. 

## What is this?
Implementation of [Standard Agents runtime specification 0.2.0](https://standardagentspec.org/0.2.0/infrastructure/runtime) intended for local only execution. 
Covers: threads with durable state, subagents, hooks, tool execution, a scoped environment,
and a sandboxed code execution engine (QuickJS) with module graph, resource limits
and termination.

State is simple file based KV store stored in project threads folder.  

The repository source is plain TypeScript that runs directly on Node — no bundler.
The published package ships `dist/` compiled JavaScript with type declarations.

## Requirements

Node **>= 22.18**. The published package is compiled JavaScript with `.d.ts`
types; the repository source is TypeScript and runs directly on Node's type
stripping. Type errors are never reported at runtime: types are erased, only
syntax and link errors surface.

## Install

```bash
npm install @t-works/standardagents-runtime
```

## CLI

```bash
npx standard-agent run ./my-agent -a assistant -m "What is idempotent?"
npx standard-agent run ./my-agent -i        # chat over stdin
npx standard-agent list ./my-agent
npx standard-agent threads --store .standard-agent
```

`<directory|package>` is a Standard Agent package (`agents/`, `prompts/`, `tools/`,
`models/`, `hooks/`, `handlers/`, `effects/`). `--json` emits JSONL runtime events.

## Programmatic use

```ts
import { Runtime } from '@t-works/standardagents-runtime';
import { loadSource, hasErrors, formatIssues } from '@t-works/standardagents-runtime/loader';
import { ThreadStore } from '@t-works/standardagents-runtime/store';
import { triggerSideFor } from '@t-works/standardagents-runtime/thread';

const { registry, issues } = await loadSource('./my-agent');
if (hasErrors(issues)) throw new Error(formatIssues(issues));

const runtime = new Runtime({
  store: new ThreadStore('.standard-agent'),
  registry,
  onEvent: (event) => console.log(event.type),
});

const thread = await runtime.createThread({ agentId: 'assistant' });
await thread.queueMessage({ role: 'user', content: 'What is idempotent?' }, { trigger: false });
await runtime.start(thread, triggerSideFor('user'));
await runtime.settle();
```

| Export | Contents |
|--------|----------|
| `.` | `Runtime`, `RuntimeOptions`, `RuntimeEvent` |
| `./thread` | `Thread`, `triggerSideFor`, state and messaging surfaces |
| `./store` | `ThreadStore` — threads, messages, queue, key-value store, files |
| `./loader` | `loadSource`, `validateRegistry`, `hasErrors`, `formatIssues` |
| `./sandbox` | `run()` — the code execution engine |
| `./hooks` | hook resolution and relationship flags |
| `./contract` | `RuntimeLike`, the surface a `Thread` needs from its runtime |

## Common mistakes

**A subagent can't find a file you gave it.** Pass the path as it exists in the
parent. The runtime copies the file into the child's own folder under the same
relative path, so the child reads `notes.txt` and gets the copy. You can hand a
child a file and no message text. If the path does not exist, the log carries a
warning and that file is skipped; the call still succeeds.

**A hook you required from a child never runs.** `parentHooks` may only name
hooks that run in a thread (like `before_create_message`, `filter_messages`).
Hooks about the person using your app (`user_value_changed`,
`user_client_attached`, `user_client_detached`) run in their session, so a
requirement naming one stops the package from loading. That is deliberate: you
find out at load time instead of wondering why nothing happened.

**A secret turned up in a tool result.** Env passed to a child is readable from
code only, with `state.env('NAME')`. To let the model see a name or a short
description, say so with `nameEnv` / `descriptionEnv`. The runtime keeps env out
of prompt text; it cannot keep it out of a result your own tool returns — a tool
that returns the `state.env()` snapshot has put that snapshot in the result.

**A function inside the sandbox never finishes.** Functions you expose to
sandboxed code may return promises, and the sandbox waits for them however long
they take: a 30ms timer is fine. What it will not do is wait past the end of the
run — a call that settles after your run is finished is dropped.

**The model re-does work from earlier turns.** `includePastTools` defaults to
`false`: each request carries the calls and results of the turn being run, and
none from the turns before it. A turn is one exchange — it starts with a message
from the other side — so a new user message starts with no tool history: the
agent keeps its own text from earlier turns, but not the calls it made or what
they returned. Set `includePastTools: true` when an agent must remember tool
work from earlier turns; the default suits an exchange that finishes inside one
turn. Either way the calls and results of the turn in progress are always sent,
so the flag never breaks a single turn.

## Development

```bash
npm install
npm test            # node --test *.test.ts — 40 tests
npm run typecheck   # tsc -p tsconfig.json, strict, no emit
npm run build       # tsc -p tsconfig.build.json → dist/ (runs on prepack)
```

`fixtures/` is a loadable Standard Agent package used by the tests. Node does not
strip types inside `node_modules`, so the package ships `dist/`; `dist` is
rebuilt by `prepack` and is not committed.

## License

MIT — see [LICENSE](LICENSE).
