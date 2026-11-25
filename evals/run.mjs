#!/usr/bin/env node
/**
 * Executes the declarative eval cases against the reference runtime.
 *
 *   node run.mjs                      # every automated case
 *   node run.mjs --suite 04           # one suite (file prefix)
 *   node run.mjs --case exec-01-...   # one case
 *   node run.mjs --baseline           # also write results/baseline.json
 *   node run.mjs --against results/baseline.json
 *
 * Cases run in-process: a fresh ThreadStore per case in the OS temp dir, the
 * `ops` become Runtime/Thread calls, the `expect` entries read the observation
 * surfaces the fixtures persist (tools.log, hooks.log, model.*, KV).
 * Structural validation is check.mjs's job; this file only runs.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Runtime } from '../runtime.ts';
import { deepseek, openrouter } from '../provider.ts';
import { loadSource, hasErrors, formatIssues } from '../loader.ts';
import { ThreadStore } from '../store.ts';
import { triggerSideFor } from '../thread.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const resultsDir = join(here, 'results');
const CASE_TIMEOUT_MS = 30_000;

// The scripted model never reaches the network, but the runtime validates a key
// before constructing any provider, so a placeholder keeps the run self-contained.
process.env.OPENAI_API_KEY ||= 'eval-dummy';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name) => argv.includes(name);
const onlySuite = flag('--suite');
const onlyCase = flag('--case');
const keep = has('--keep');

const runtimeVersion = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const gitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const { registry, issues } = await loadSource(fixtures);
if (hasErrors(issues)) {
  console.error(formatIssues(issues.filter((issue) => issue.severity === 'error')));
  process.exit(1);
}

// --model <id> points every prompt at one live provider instead of the scripted
// stand-in. The model records the same provider-level surfaces the scripted
// fixtures do (model.calls, model.requestLog, model.views), so a live run is
// judged on delivery rather than on bookkeeping it never wrote. It stays a smoke
// test, not the conformance gate: the model chooses its own turns and tool calls.
const liveModel = flag('--model');
if (liveModel) {
  const providers = { deepseek, openrouter };
  const name = flag('--provider') ?? 'deepseek';
  const provider = providers[name];
  if (!provider) {
    console.error('unknown --provider ' + name + ', expected one of ' + Object.keys(providers).join(', '));
    process.exit(2);
  }
  const textOf = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => (typeof part === 'string' ? part : (part.text ?? part.content ?? ''))).join('');
  };
  const newestUser = (request) => {
    for (let index = request.messages.length - 1; index >= 0; index--) {
      if (request.messages[index].role === 'user') return request.messages[index];
    }
    return null;
  };
  // The wrapper must keep the preset's config slots, or the runtime has no slot
  // to read DEEPSEEK_API_KEY from and falls back to the placeholder key.
  const recording = (config, context) => {
    const inner = provider(config, context);
    const state = context?.state;
    return {
      ...inner,
      generate: async (request) => {
        if (state) {
          const system = request.messages.find((entry) => entry.role === 'system');
          const user = newestUser(request);
          const log = (await state.getValue('model.requestLog')) ?? [];
          log.push({
            system: system ? textOf(system.content) : '',
            user: user ? textOf(user.content) : '',
            users: request.messages.filter((entry) => entry.role === 'user').map((entry) => textOf(entry.content)),
            roles: request.messages.map((entry) => entry.role ?? 'user'),
            toolDetail: JSON.stringify(request.tools ?? []),
            tools: (request.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? ''),
            parts: user ? (user.content ?? null) : null,
          });
          await state.setValue('model.requestLog', log);
          await state.setValue('model.calls', log.length);
          const views = (await state.getValue('model.views')) ?? [];
          views.push({
            side: state.activeSide ?? null,
            messages: request.messages.map((row) => ({
              role: row.role,
              content: typeof row.content === 'string' ? row.content : null,
              toolCalls: (row.toolCalls ?? []).map((call) => call.name),
            })),
          });
          await state.setValue('model.views', views);
        }
        return inner.generate(request);
      },
    };
  };
  recording.configSlots = provider.configSlots;
  registry.models.set('live', { name: 'live', model: liveModel, capabilities: { supportsImages: true }, provider: recording });
  for (const prompt of registry.prompts.values()) prompt.model = 'live';
}

// ── value comparison ───────────────────────────────────────────────────────
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
};
/** Objects match if every expected key matches; arrays match elementwise. */
const partial = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => partial(actual[i], item));
  if (isPlain(expected)) return isPlain(actual) && Object.entries(expected).every(([key, value]) => partial(actual[key], value));
  return actual === expected;
};
const elementMatches = (candidate, expected, kind) => {
  // Message assertions are about text: `messages.contains: ["Started w1"]` is a substring test.
  if (typeof candidate === 'string' && typeof expected === 'string') return kind.startsWith('messages.') ? candidate.includes(expected) : candidate === expected;
  return isPlain(expected) || Array.isArray(expected) ? partial(candidate, expected) : deepEqual(candidate, expected);
};
const subsequence = (haystack, needles) => {
  let cursor = 0;
  for (const needle of needles) {
    while (cursor < haystack.length && !String(haystack[cursor]).includes(String(needle))) cursor++;
    if (cursor === haystack.length) return false;
    cursor++;
  }
  return true;
};
const contains = (actual, expected, kind) => {
  if (typeof actual === 'string') return actual.includes(String(expected));
  if (Array.isArray(actual)) {
    const items = Array.isArray(expected) ? expected : [expected];
    if (kind === 'messages.contents') return subsequence(actual, items);
    return items.every((item) => actual.some((candidate) => elementMatches(candidate, item, kind)));
  }
  return false;
};
/** Kinds whose `equals` is a partial match rather than deep equality. */
const PARTIAL_EQUALS = new Set(['values', 'code', 'children', 'queue', 'model.views']);

function judge(kind, actual, expect) {
  for (const key of Object.keys(expect)) {
    if (key === 'kind' || key === 'thread' || key === 'index' || key === 'field' || key === 'name') continue;
    switch (key) {
      case 'equals':
        return { ok: PARTIAL_EQUALS.has(kind) ? partial(actual, expect.equals) : deepEqual(actual, expect.equals), expected: expect.equals };
      case 'notEquals':
        return { ok: !deepEqual(actual, expect.notEquals), expected: { notEquals: expect.notEquals } };
      case 'contains':
        return { ok: contains(actual, expect.contains, kind), expected: { contains: expect.contains } };
      case 'notContains':
        return { ok: !contains(actual, expect.notContains, kind), expected: { notContains: expect.notContains } };
      case 'oneOf':
        return { ok: expect.oneOf.some((value) => deepEqual(actual, value)), expected: { oneOf: expect.oneOf } };
      case 'atLeast':
        return { ok: typeof actual === 'number' && actual >= expect.atLeast, expected: { atLeast: expect.atLeast } };
      case 'length':
        return { ok: actual != null && actual.length === expect.length, expected: { length: expect.length } };
      default:
        throw new Error('unknown comparison ' + key);
    }
  }
  throw new Error('assertion has no comparison');
}

// ── observation surfaces ───────────────────────────────────────────────────
const messageToolCalls = (thread) => {
  const calls = [];
  for (const message of thread.allMessages()) {
    if (!message.tool_calls) continue;
    for (const call of JSON.parse(message.tool_calls)) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = call.function?.arguments ?? null;
      }
      calls.push({ name: call.function?.name, args });
    }
  }
  return calls;
};
const toolMessages = (thread) => thread.allMessages().filter((m) => m.role === 'tool');
const contents = (thread) => thread.allMessages().map((m) => m.content).filter((c) => typeof c === 'string' && c.length);
const kv = (thread, store) => store.loadKv(thread.threadId);

const READERS = {
  'messages.roles': (t) => t.allMessages().map((m) => m.role),
  'messages.contents': (t) => contents(t),
  'messages.contains': (t) => contents(t),
  'messages.attachments': (t) => t.allMessages().flatMap((m) => m.attachments ?? []),
  'tools.order': (t) => toolMessages(t).map((m) => m.name),
  'tools.args': (t) => messageToolCalls(t).map((call) => call.args),
  'tools.status': (t) => toolMessages(t).map((m) => m.tool_status),
  'tools.results': (t) => toolMessages(t).map((m) => m.content),
  // shortcut: the slow fixture records its peak itself; no runtime surface exists for this.
  'tools.maxConcurrent': async (t) => (await t.getValue('tools.maxInFlight')) ?? null,
  'model.calls': async (t) => (await t.getValue('model.calls')) ?? 0,
  'model.views': async (t) => (await t.getValue('model.views')) ?? [],
  'model.requests': async (t) => (await t.getValue('model.requestLog')) ?? [],
  values: async (t, ctx) => kv(t, ctx.store),
  status: async (t) => (await t.status()).state,
  terminated: (t) => t.terminated,
  children: (t) => t.children,
  queue: (t, ctx) => ctx.store.loadQueue(t.threadId),
  'hooks.order': async (t, ctx, expect) => {
    const log = (await t.getValue('hooks.log')) ?? [];
    return (expect.name ? log.filter((entry) => entry.hook === expect.name) : log).map((entry) => entry.id);
  },
  code: async (t) => (await t.getValue('runCode.log')) ?? [],
  effects: async (t) => ((await t.getValue('effects.log')) ?? []).map((entry) => entry.effect),
  rejected: (_t, ctx) => ctx.rejected,
  // A case that loads its own package never touches the fixtures registry.
  'load.issues': (_t, ctx) => ctx.load?.issues ?? [],
};

const fieldOf = (value, key) => {
  if (value == null) return null;
  // `values` fields are literal KV keys (`system.current`), code fields are paths (`error.message`).
  if (typeof value === 'object' && key in value) return value[key];
  let cursor = value;
  for (const part of String(key).split('.')) cursor = cursor == null ? null : cursor[part];
  return cursor ?? null;
};

// ── one case ───────────────────────────────────────────────────────────────
async function runCase(testCase) {
  const started = process.hrtime.bigint();
  const dir = mkdtempSync(join(tmpdir(), 'saeval-'));
  const store = new ThreadStore(dir);
  const events = [];
  let runtime = new Runtime({ store, registry, onEvent: (event) => events.push(event) });
  const state = { thread: null, rejected: null, load: null };
  const ensure = async () => {
    state.thread ??= await runtime.createThread({ agentId: testCase.agent, env: testCase.env ?? {} });
    return state.thread;
  };
  const known = async () => {
    const all = state.thread ? [state.thread] : [];
    for (const parent of [...all]) for (const child of parent.children) {
      const thread = await parent.getChildThread(child.reference);
      if (thread && !all.includes(thread)) all.push(thread);
    }
    return all;
  };
  const settle = async () => {
    // Two rounds: effects scheduled during the first settle (immediate children) get one too.
    for (let round = 0; round < 2; round++) {
      for (const thread of await known()) await runtime.drainDueEffects(thread).catch(() => {});
      await runtime.settle();
    }
  };
  const send = async (text, asyncSend) => {
    const thread = await ensure();
    const agent = thread.agent;
    const humanSide = agent.sideA.human ? 'a' : agent.sideB?.human ? 'b' : null;
    const role = humanSide === 'a' ? 'assistant' : 'user';
    await thread.queueMessage({ role, content: text }, { trigger: false });
    const run = runtime.start(thread, triggerSideFor(role));
    if (asyncSend) {
      run.catch(() => {});
      // Let the step reach its model call first, or a later queue op lands in the same step.
      const promptBacked = Boolean(thread.agent.sideA.prompt || thread.agent.sideB?.prompt);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const called = (await thread.getValue('model.calls')) ?? 0;
        const queued = store.loadQueue(thread.threadId).length;
        if (promptBacked ? called > 0 : queued === 0) break;
        if (!runtime.isBusy(thread.threadId) && queued === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return;
    }
    await runtime.settle();
  };

  const applyOp = async (op) => {
    if ('createThread' in op) {
      await ensure();
      return;
    }
    if ('send' in op) return send(op.send, op.async === true);
    if ('queueMessage' in op) {
      const { trigger, ...input } = op.queueMessage;
      return (await ensure()).queueMessage(input, trigger === undefined ? {} : { trigger });
    }
    if ('queueTool' in op) {
      const { name, args } = op.queueTool;
      return (await ensure()).queueTool(name, args ?? {});
    }
    if ('injectMessage' in op) return (await ensure()).injectMessage(op.injectMessage);
    if ('scheduleEffect' in op) {
      const { name, args, delay } = op.scheduleEffect;
      return (await ensure()).scheduleEffect(name, args ?? {}, delay ?? 0);
    }
    if ('terminate' in op) return (await ensure()).terminate();
    if ('settle' in op) return settle();
    if ('restart' in op) {
      // A new process over the same store: fresh Runtime, thread rehydrated from disk.
      const id = (await ensure()).threadId;
      runtime = new Runtime({ store, registry, onEvent: (event) => events.push(event) });
      state.thread = runtime.threadFor(store.load(id));
      return;
    }
    if ('sleep' in op) return new Promise((resolve) => setTimeout(resolve, op.sleep.ms));
    if ('expectRejected' in op) {
      try {
        await applyOp({ [op.expectRejected.op]: op.expectRejected.value });
        state.rejected = false;
      } catch {
        state.rejected = true;
      }
      return;
    }
    throw new Error('unknown op ' + JSON.stringify(op));
  };

  const assertions = [];
  try {
    if (testCase.load) state.load = await loadSource(join(here, testCase.load));
    for (const op of testCase.ops ?? []) await applyOp(op);
    await runtime.settle();
    for (const expect of testCase.expect ?? []) {
      const reader = READERS[expect.kind];
      if (!reader) throw new Error('unknown assertion kind ' + expect.kind);
      if (expect.kind === 'load.issues' && !state.load) throw new Error('load.issues needs a load field on the case');
      const thread = expect.kind === 'load.issues' ? null : expect.thread?.startsWith('child:')
        ? await (async () => {
            const relationship = expect.thread.slice('child:'.length);
            const parent = await ensure();
            const entry = parent.children.find((child) => child.relationship === relationship);
            return entry ? await parent.getChildThread(entry.reference) : null;
          })()
        : await ensure();
      if (!thread && expect.kind !== 'load.issues') throw new Error('no thread for ' + (expect.thread ?? 'parent'));
      let actual = await reader(thread, { store, rejected: state.rejected, load: state.load }, expect);
      if (expect.index !== undefined && Array.isArray(actual)) actual = actual.at(expect.index) ?? null;
      if (expect.field !== undefined) actual = fieldOf(actual, expect.field);
      const verdict = judge(expect.kind, actual, expect);
      assertions.push({ kind: expect.kind, ...(expect.thread ? { thread: expect.thread } : {}), ...(expect.index !== undefined ? { index: expect.index } : {}), ...(expect.field ? { field: expect.field } : {}), ok: verdict.ok, expected: shrink(verdict.expected), actual: verdict.ok ? undefined : shrink(actual) });
    }
  } catch (error) {
    return finish('error', { error: error instanceof Error ? error.message : String(error) });
  }

  const failed = assertions.filter((entry) => !entry.ok);
  return finish(failed.length ? 'fail' : 'pass');

  function finish(status, extra = {}) {
    const notImplemented = /not implemented by this runtime/.test(JSON.stringify({ events, ...extra }));
    const run = {
      id: testCase.id,
      status: status === 'pass' ? 'pass' : notImplemented ? 'not-implemented' : status,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      assertions,
      ...extra,
    };
    if (run.status !== 'pass' && events.length) run.events = events.slice(-200).map(shrink);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else run.store = dir;
    return { run, dir };
  }
}

const shrink = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > 1200 ? JSON.parse(JSON.stringify(text.slice(0, 1200) + '…')) : value;
};

// ── suites ─────────────────────────────────────────────────────────────────
const suites = readdirSync(join(here, 'suites'))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .filter((file) => !onlySuite || file.startsWith(onlySuite))
  .map((file) => ({ file, ...JSON.parse(readFileSync(join(here, 'suites', file), 'utf8')) }));
if (!suites.length) {
  console.error('no suite matches ' + onlySuite);
  process.exit(1);
}

const startedAt = new Date();
const runStarted = process.hrtime.bigint();
const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${gitSha ?? 'nogit'}`;
const cases = [];
const manual = [];
mkdirSync(join(resultsDir, 'runs'), { recursive: true });

for (const suite of suites) {
  for (const testCase of suite.cases) {
    if (onlyCase && testCase.id !== onlyCase) continue;
    if (suite.automated === false || testCase.automated === false) {
      manual.push({ id: testCase.id, suite: suite.file, requirements: testCase.requirements });
      continue;
    }
    const result = await Promise.race([
      runCase(testCase),
      new Promise((resolve) => setTimeout(() => resolve({ run: { id: testCase.id, status: 'error', error: 'timeout', assertions: [] }, dir: null }), CASE_TIMEOUT_MS)),
    ]);
    // Keep the thread store of a failing case: three small files beat re-running it.
    if (result.run.status !== 'pass' && result.dir && existsSync(result.dir)) {
      const dest = join(resultsDir, 'runs', runId, testCase.id);
      mkdirSync(dest, { recursive: true });
      cpSync(result.dir, dest, { recursive: true });
      result.run.store = path.relative(here, dest).replaceAll('\\', '/');
    }
    cases.push({ suite: suite.file, ...result.run });
    process.stdout.write(marker(result.run.status));
    if (!keep && result.dir) rmSync(result.dir, { recursive: true, force: true });
  }
}

function marker(status) {
  return { pass: '.', fail: 'F', error: 'E', 'not-implemented': 'n', manual: '-' }[status] ?? '?';
}

const totals = {
  pass: cases.filter((entry) => entry.status === 'pass').length,
  fail: cases.filter((entry) => entry.status === 'fail').length,
  error: cases.filter((entry) => entry.status === 'error').length,
  notImplemented: cases.filter((entry) => entry.status === 'not-implemented').length,
  manual: manual.length,
};
const durationMs = Math.round(Number(process.hrtime.bigint() - runStarted) / 1e6);
const results = {
  run: {
    id: runId,
    gitSha,
    runtimeVersion,
    model: liveModel ?? 'scripted',
    specVersion: JSON.parse(readFileSync(join(here, 'requirements.json'), 'utf8')).specVersion,
    node: process.version,
    startedAt: startedAt.toISOString(),
    durationMs,
    totals,
  },
  cases,
  manual,
};

// ── report ─────────────────────────────────────────────────────────────────
console.log('\n');
for (const entry of cases.filter((item) => item.status !== 'pass')) {
  const detail = entry.error
    ? entry.error
    : entry.assertions.filter((a) => !a.ok).map((a) => `${a.kind}${a.index !== undefined ? `[${a.index}]` : ''}${a.field ? `.${a.field}` : ''}: expected ${JSON.stringify(a.expected)} got ${JSON.stringify(a.actual)}`).join('\n    ');
  console.log(`${entry.status.toUpperCase().padEnd(14)} ${entry.id}`);
  if (detail) console.log('  ' + detail);
}
console.log(`\npass ${totals.pass}  fail ${totals.fail}  error ${totals.error}  not-implemented ${totals.notImplemented}  manual ${totals.manual}   (${durationMs} ms, runner ${runtimeVersion})`);

const outFile = flag('--out') ?? join(resultsDir, 'runs', `${results.run.id}.json`);
writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
console.log('results → ' + path.relative(process.cwd(), outFile).replaceAll('\\', '/'));

// A live run and the scripted gate keep separate baselines: the scripted cases
// assert turns only the scripted fixture produces, so one cannot judge the other.
const baselineFile = join(resultsDir, liveModel ? `baseline-${liveModel.replace(/[^\w.-]/g, '_')}.json` : 'baseline.json');

if (has('--baseline')) {
  if (onlySuite || onlyCase) {
    console.error('refusing to write a baseline from a filtered run (--suite/--case)');
    process.exit(2);
  }
  writeFileSync(baselineFile, JSON.stringify(results, null, 2) + '\n');
  console.log('baseline ← ' + path.relative(process.cwd(), baselineFile).replaceAll('\\', '/'));
}

// ── comparison ─────────────────────────────────────────────────────────────
// A filtered run has no opinion about the cases it skipped, so only full runs compare by default.
const against = flag('--against') ?? (has('--baseline') || onlySuite || onlyCase ? undefined : existsSync(baselineFile) ? baselineFile : undefined);
if (against) {
  const previous = JSON.parse(readFileSync(against, 'utf8'));
  if (previous.run.specVersion !== results.run.specVersion) {
    console.error(`\nrefusing to compare: spec version changed (${previous.run.specVersion} → ${results.run.specVersion})`);
    process.exit(2);
  }
  if ((previous.run.model ?? 'scripted') !== results.run.model) {
    console.error(`\nrefusing to compare: run model changed (${previous.run.model ?? 'unrecorded'} → ${results.run.model}); a live run and the scripted gate do not share a baseline`);
    process.exit(2);
  }
  const before = new Map(previous.cases.map((entry) => [entry.id, entry.status]));
  const transitions = { regression: [], fixed: [], added: [], removed: [] };
  for (const entry of cases) {
    const was = before.get(entry.id);
    if (was === undefined) {
      transitions.added.push(entry.id);
      continue;
    }
    before.delete(entry.id);
    if (entry.status === was) continue;
    const worsened = entry.status !== 'pass' && (was === 'pass' || (was === 'not-implemented' && entry.status !== 'not-implemented'));
    if (worsened) transitions.regression.push(`${entry.id}: ${was} → ${entry.status}`);
    else transitions.fixed.push(`${entry.id}: ${was} → ${entry.status}`);
  }
  transitions.removed = [...before.keys()];
  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label}`);
    for (const line of list) console.log('  ' + line);
  };
  show('regressions', transitions.regression);
  show('fixed', transitions.fixed);
  show('new cases', transitions.added);
  show('gone cases', transitions.removed);
  if (transitions.regression.length) {
    console.log('\nFAILED: regressions against ' + against);
    process.exit(1);
  }
}

if (totals.fail || totals.error) {
  console.log('\nFAILED: ' + (totals.fail + totals.error) + ' case(s) not passing');
  process.exit(1);
}
