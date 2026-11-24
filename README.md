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

## Development

```bash
npm install
npm test            # node --test *.test.ts — 36 tests
npm run typecheck   # tsc -p tsconfig.json, strict, no emit
npm run build       # tsc -p tsconfig.build.json → dist/ (runs on prepack)
```

`fixtures/` is a loadable Standard Agent package used by the tests. Node does not
strip types inside `node_modules`, so the package ships `dist/`; `dist` is
rebuilt by `prepack` and is not committed.

## License

MIT — see [LICENSE](LICENSE).
