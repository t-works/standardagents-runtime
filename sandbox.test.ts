// Unit 01 spike: what quickjs-emscripten provides for §14.1–§14.4. Disposable —
// it pins the engine behaviour the ADR relies on, not the runtime API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run as runCode } from './sandbox.ts';
import { getQuickJS } from 'quickjs-emscripten';

const QuickJS = await getQuickJS();

type Outcome = { value: unknown } | { status: 'memory' | 'terminated'; message: string };

const run = (source: string, limits: { memoryLimitBytes?: number; interruptAfter?: number } = {}): Outcome => {
  const runtime = QuickJS.newRuntime();
  if (limits.memoryLimitBytes) runtime.setMemoryLimit(limits.memoryLimitBytes);
  if (limits.interruptAfter !== undefined) {
    let ticks = 0;
    runtime.setInterruptHandler(() => ++ticks > limits.interruptAfter!);
  }
  const context = runtime.newContext();
  try {
    const result = context.evalCode(source);
    if (result.error) {
      const dumped = context.dump(result.error) as { name: string; message: string };
      result.error.dispose();
      // QuickJS reports a heap overrun and an interrupt alike, as InternalError.
      if (dumped.message === 'out of memory') return { status: 'memory', message: `heap limit ${limits.memoryLimitBytes} bytes` };
      if (dumped.message === 'interrupted') return { status: 'terminated', message: dumped.message };
      throw new Error(`${dumped.name}: ${dumped.message}`);
    }
    const value = context.dump(result.value);
    result.value.dispose();
    return { value };
  } finally {
    context.dispose();
    runtime.dispose();
  }
};

test('a fresh context per call leaks nothing across calls', () => {
  assert.deepEqual(run('globalThis.leaked = 1'), { value: 1 });
  assert.deepEqual(run('typeof globalThis.leaked'), { value: 'undefined' });
});

test('eval can be deleted, so the escape hatch is closable in-engine', () => {
  assert.deepEqual(run('delete globalThis.eval; try { eval("1"); "reachable" } catch (e) { e.name }'), {
    value: 'ReferenceError',
  });
});

test('a heap limit settles memory instead of killing the host', () => {
  assert.deepEqual(run('const hog = []; while (true) hog.push(new Array(1e5).fill(0))', { memoryLimitBytes: 4 * 1024 * 1024 }), {
    status: 'memory',
    message: 'heap limit 4194304 bytes',
  });
});

test('the interrupt handler settles a tight loop as terminated', () => {
  assert.deepEqual(run('while (true) {}', { interruptAfter: 1000 }), { status: 'terminated', message: 'interrupted' });
});

test('a type-erasure failure keeps the caller line and column', async () => {
  const result = await runCode('const x: = 1;\nexport default x;');
  assert.equal(result.status, 'error');
  assert.equal(result.error?.line, 1);
  assert.ok((result.error?.column ?? 0) > 1, 'column points at the caret, not the start of the line');
});

test('an engine error reports the caller line, not the bindings prefix', async () => {
  const result = await runCode('export default (() => { null.x; })();', { globals: { G: 1 } });
  assert.equal(result.status, 'error');
  assert.equal(result.error?.line, 1);
});

test('the handle is a thenable that stops running once it settles', async () => {
  const handle = runCode('export default 1;');
  assert.equal(handle.running, true);
  assert.equal((await handle).status, 'success');
  assert.equal(handle.running, false);
});

test('a heap overrun settles memory and names the effective limit', async () => {
  const result = await runCode('const block = new Array(8 * 1024 * 1024).fill(1);\nexport default block.length;', {
    memoryLimitBytes: 1024 * 1024,
  });
  assert.equal(result.status, 'memory');
  assert.match(result.error?.message ?? '', /1048576 bytes/);
});

test('a request above the ceiling clamps instead of rejecting', async () => {
  const result = await runCode('export default 1;', { memoryLimitBytes: 4096 * 1024 * 1024 });
  assert.equal(result.status, 'success');
});

test('Map, Set, Date and typed arrays cross in as copies and out as their own types', async () => {
  const map = new Map([['k', 1]]);
  const inbound = await runCode(
    'export default { size: MAP.size, value: MAP.get("k"), set: [...SET], day: DAY.getTime(), bytes: [...BYTES] };',
    { globals: { MAP: map, SET: new Set([1, 2]), DAY: new Date(0), BYTES: new Uint8Array([1, 2, 3]) } },
  );
  assert.deepEqual(inbound.result, { size: 1, value: 1, set: [1, 2], day: 0, bytes: [1, 2, 3] });
  // A structured clone: mutating the guest copy must not reach the host value.
  map.set('later', 2);
  assert.equal(inbound.result && (inbound.result as { size: number }).size, 1);

  const outbound = await runCode(
    'export default { map: new Map([["k", 1]]), set: new Set([1]), day: new Date(0), bytes: new Uint8Array([1, 2]) };',
  );
  const value = outbound.result as { map: Map<string, number>; set: Set<number>; day: Date; bytes: Uint8Array };
  assert.equal(value.map.get('k'), 1);
  assert.deepEqual([...value.set], [1]);
  assert.equal(value.day.getTime(), 0);
  assert.deepEqual([...value.bytes], [1, 2]);
});

test('a bridged host function that returns a promise is awaited in the sandbox', async () => {
  // The host settles after a real event-loop turn, so `await` has to cross the boundary, not just a microtask.
  const result = await runCode('import { later } from "host";\nexport default await later(21);', {
    imports: { host: { later: (n: number) => new Promise((resolve) => setImmediate(() => resolve(n * 2))) } },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.result, 42);
});

test('terminate settles terminated with the caller reason at a yield point', async () => {
  const handle = runCode('while (true) { await Promise.resolve(); }');
  setTimeout(() => handle.terminate('probe-terminate'), 20);
  const result = await handle;
  assert.equal(result.status, 'terminated');
  assert.match(result.error?.message ?? '', /probe-terminate/);
  assert.equal(handle.running, false);
  // SHOULD be <= 50 ms; 500 leaves room for a loaded CI box without asserting the number.
  assert.ok(result.durationMs < 500, `settled in ${result.durationMs}ms`);
});

test('terminate is idempotent: the first reason wins and a settled handle ignores it', async () => {
  const handle = runCode('while (true) { await Promise.resolve(); }');
  setTimeout(() => {
    handle.terminate('first');
    handle.terminate('second');
  }, 20);
  const result = await handle;
  assert.equal(result.error?.message, 'first');
  handle.terminate('third');
  assert.equal(handle.running, false);
});

test('terminate without a reason still names a diagnosable cause', async () => {
  const handle = runCode('while (true) { await Promise.resolve(); }');
  setTimeout(() => handle.terminate(), 20);
  assert.equal((await handle).error?.message, 'terminated by caller');
});

test('terminate during a pending bridged promise does not abort the engine', async () => {
  const handle = runCode('import { wait } from "host";\nexport default await wait();', {
    imports: { host: { wait: () => new Promise(() => {}) } },
  });
  setTimeout(() => handle.terminate('gave up'), 20);
  assert.equal((await handle).status, 'terminated');
  assert.equal((await runCode('export default 1;')).status, 'success');
});

test('a bridge that settles after the run ended is dropped, not thrown', async () => {
  const handle = runCode('import { wait } from "host";\nexport default await wait();', {
    imports: { host: { wait: () => new Promise((resolve) => setTimeout(() => resolve(1), 50)) } },
  });
  setTimeout(() => handle.terminate('late'), 10);
  assert.equal((await handle).status, 'terminated');
  // Reaching the assertions means the late settlement threw nowhere: it would arrive uncaught, from a host microtask.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await runCode('export default 2;')).result, 2);
});

test('a bridged host function is invoked with no receiver', async () => {
  const result = await runCode('import { read } from "host";\nexport default read.call({ stolen: true });', {
    imports: {
      host: {
        read(this: unknown) {
          return this === undefined ? 'no-this' : 'stolen-this';
        },
      },
    },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.result, 'no-this');
});

test('a class instance is not transferable', async () => {
  class Thing {}
  await assert.rejects(
    async () => {
      await runCode('export default 1;', { globals: { THING: new Thing() } });
    },
    /cannot cross the sandbox boundary/,
  );
});

test('a bare specifier resolves only from imports, a relative one only from modules', async () => {
  const bareFromModules = await runCode('import { x } from "lib"; export default x;', { modules: { lib: 'export const x = 1;' } });
  assert.equal(bareFromModules.status, 'link_error');
  const relativeFromImports = await runCode('import { x } from "./lib.js"; export default x;', { imports: { './lib.js': { x: 1 } } });
  assert.equal(relativeFromImports.status, 'link_error');
});

test('a named import the module does not export is a link error, not a runtime error', async () => {
  const result = await runCode('import { missing } from "host"; export default missing;', { imports: { host: {} } });
  assert.equal(result.status, 'link_error');
  assert.equal(result.error?.specifier, 'host');
});

test('a heap overrun settles memory and names the effective limit', async () => {
  const result = await runCode('const hog = []; while (true) hog.push(new Array(1e5).fill(0));', {
    memoryLimitBytes: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 'memory');
  assert.match(result.error?.message ?? '', /memory limit 4194304 bytes/);
});

test('a code constructor is unreachable through the constructor chain', async () => {
  for (const source of [
    'export default (function () {}).constructor("return 1")();',
    'export default ({}).constructor.constructor("return 1")();',
    'export default [].map.constructor("return 1")();',
    'export default (function* () {}).constructor("return 1")();',
    'export default (async function () {}).constructor("return 1")();',
  ]) {
    const result = await runCode(source);
    assert.equal(result.status, 'error', source);
    assert.equal(result.result, undefined, source);
  }
  // `Object` is the only link left on those chains, and it cannot compile source.
  const chains = await runCode(
    'export default [(function () {}).constructor === Object, ({}).constructor.constructor === Object, (function* () {}).constructor === Object, (async function () {}).constructor === Object];',
  );
  assert.deepEqual(chains.result, [true, true, true, true]);
});

test('a data: URL import is a link error, like the case expects of a https one', async () => {
  const result = await runCode('const module = await import("data:text/javascript,export default 1");\nexport default 1;');
  assert.equal(result.status, 'link_error');
  assert.equal(result.error?.specifier, 'data:text/javascript,export default 1');
});

test('a prototype write stays inside the sandbox', async () => {
  const result = await runCode('(Object.prototype as any).hacked = true; export default "mutated";');
  assert.equal(result.status, 'success');
  assert.equal(({} as Record<string, unknown>).hacked, undefined);
});
