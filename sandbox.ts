/**
 * The sandbox behind `ThreadState.runCode` (§14). Unit 02 gives the contract
 * shape: one entry module in a fresh QuickJS context, the configured export
 * executed, a `CodeExecutionResult` out. Unit 03 adds the module graph (imports,
 * modules, synthetic URLs), unit 07 the heap limit. Hardening lands in 04, the
 * marshaling matrix in 05, termination in 06.
 */
import { stripTypeScriptTypes } from 'node:module';
import { posix } from 'node:path';
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten';
import type {
  CodeExecution,
  CodeExecutionError,
  CodeExecutionLog,
  CodeExecutionOptions,
  CodeExecutionResult,
  CodeExecutionStatus,
} from '@standardagents/spec';

/** One WASM initialisation per process; every call still gets a fresh runtime. */
const engine = getQuickJS();

const DEFAULT_FILENAME = '<runCode>';
/** Channel for module-scope globals; removed before the entry module suspends. */
const BINDINGS = '__runCodeBindings';
/** Channel for marshaled import namespaces; emptied as each synthetic module reads it. */
const MODULE_CHANNEL = '__runCodeModules';
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
/** Jobs driven per yield point; each batch ends with one event-loop turn. */
const JOBS_PER_BATCH = 1024;
/** §14.4 default message when `terminate()` is called without a reason. */
const TERMINATED_BY_CALLER = 'terminated by caller';

/** §14.4 default when the caller asks for nothing: 64 MiB, cheap enough to overrun in a test. */
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The WASM module declares 32768 pages of 64 KiB; a larger request is clamped to it. */
const MEMORY_CEILING_BYTES = 32768 * 64 * 1024;
/** How QuickJS reports a heap overrun; the runtime turns it into `status: 'memory'`. */
const OUT_OF_MEMORY = 'out of memory';

/** §14.3 lands here: one codec pair tags values, because neither side can mint the other's classes. */
class SerializationError extends Error {
  override name = 'SerializationError';
}

/**
 * The guest half of the codec. Tags are the contract: `u` undefined, `n` a
 * non-finite number, `b` bigint, `f` a bridged host function, `d` Date, `t` a
 * typed array, `m` Map, `s` Set, `a` Array, `o` a plain object.
 */
const CODEC_SOURCE = `(() => {
  const tag = (value, seen) => {
    if (typeof value === 'undefined') return { $: 'u' };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $: 'n', v: String(value) };
    if (typeof value === 'bigint') return { $: 'b', v: String(value) };
    if (typeof value === 'function') throw new TypeError('a sandbox function cannot cross to the host');
    if (typeof value === 'symbol') throw new TypeError('a symbol cannot cross the sandbox boundary');
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new TypeError('a self-referencing value cannot cross the sandbox boundary');
    seen.add(value);
    try {
      if (Array.isArray(value)) return { $: 'a', v: value.map((item) => tag(item, seen)) };
      if (value instanceof Date) return { $: 'd', v: value.getTime() };
      if (value instanceof Map) return { $: 'm', v: [...value].map(([key, item]) => [tag(key, seen), tag(item, seen)]) };
      if (value instanceof Set) return { $: 's', v: [...value].map((item) => tag(item, seen)) };
      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return { $: 't', t: value.constructor.name, v: [...value].map(String) };
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('a class instance cannot cross the sandbox boundary');
      const out = {};
      for (const key of Object.keys(value)) out[key] = tag(value[key], seen);
      return { $: 'o', v: out };
    } finally {
      seen.delete(value);
    }
  };
  const untag = (node, fns) => {
    if (node === null || typeof node !== 'object') return node;
    switch (node.$) {
      case 'u': return undefined;
      case 'n': return Number(node.v);
      case 'b': return BigInt(node.v);
      case 'f': return fns[node.v];
      case 'd': return new Date(node.v);
      case 't': return new globalThis[node.t](node.v.map((item) => (node.t.startsWith('Big') ? BigInt(item) : Number(item))));
      case 'a': return node.v.map((item) => untag(item, fns));
      case 'm': return new Map(node.v.map(([key, item]) => [untag(key, fns), untag(item, fns)]));
      case 's': return new Set(node.v.map((item) => untag(item, fns)));
      default: {
        const out = {};
        for (const key of Object.keys(node.v)) out[key] = untag(node.v[key], fns);
        return out;
      }
    }
  };
  return {
    encode: (value) => JSON.stringify(tag(value, new Set())),
    decode: (json, fns) => untag(JSON.parse(json), fns),
  };
})()`;

type Tree = unknown;
/** Host functions met while encoding, in tag order; `marshalIn` turns them into guest proxies. */
type HostFunctions = ((...args: never[]) => unknown)[];

const encodeTree = (value: unknown, functions: HostFunctions, seen: Set<object> = new Set()): Tree => {
  if (typeof value === 'function') {
    functions.push(value as (...args: never[]) => unknown);
    return { $: 'f', v: functions.length - 1 };
  }
  if (typeof value === 'undefined') return { $: 'u' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $: 'n', v: String(value) };
  if (typeof value === 'bigint') return { $: 'b', v: String(value) };
  if (typeof value === 'symbol') throw new SerializationError('a symbol cannot cross the sandbox boundary');
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new SerializationError('a self-referencing value cannot cross the sandbox boundary');
  seen.add(value);
  try {
    if (Array.isArray(value)) return { $: 'a', v: value.map((item) => encodeTree(item, functions, seen)) };
    if (value instanceof Date) return { $: 'd', v: value.getTime() };
    if (value instanceof Map) {
      return {
        $: 'm',
        v: [...value].map(([key, item]) => [encodeTree(key, functions, seen), encodeTree(item, functions, seen)]),
      };
    }
    if (value instanceof Set) return { $: 's', v: [...value].map((item) => encodeTree(item, functions, seen)) };
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return { $: 't', t: value.constructor.name, v: Array.from(value as unknown as ArrayLike<number>, String) };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SerializationError(`${value.constructor?.name ?? 'a class instance'} cannot cross the sandbox boundary`);
    }
    const out: Record<string, Tree> = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[key] = encodeTree(item, functions, seen);
    return { $: 'o', v: out };
  } finally {
    seen.delete(value);
  }
};

const decodeTree = (node: Tree): unknown => {
  if (node === null || typeof node !== 'object') return node;
  const tagged = node as { $: string; v?: unknown; t?: string };
  switch (tagged.$) {
    case 'u':
      return undefined;
    case 'n':
      return Number(tagged.v);
    case 'b':
      return BigInt(tagged.v as string);
    case 'd':
      return new Date(tagged.v as number);
    case 't': {
      const name = tagged.t as string;
      const Ctor = (globalThis as Record<string, unknown>)[name] as new (list: unknown[]) => unknown;
      return new Ctor((tagged.v as string[]).map((item) => (name.startsWith('Big') ? BigInt(item) : Number(item))));
    }
    case 'a':
      return (tagged.v as Tree[]).map(decodeTree);
    case 'm':
      return new Map((tagged.v as [Tree, Tree][]).map(([key, item]) => [decodeTree(key), decodeTree(item)]));
    case 's':
      return new Set((tagged.v as Tree[]).map(decodeTree));
    case 'o':
      return Object.fromEntries(Object.entries(tagged.v as Record<string, Tree>).map(([key, item]) => [key, decodeTree(item)]));
    default:
      throw new SerializationError(`unknown marshaling tag '${String(tagged.$)}'`);
  }
};

/**
 * §14.1-5: remove the capability, not the name. Each code constructor is still
 * reachable from an instance's prototype, so the `constructor` property is the
 * hatch that actually closes; a denylist over `globalThis` alone would not be.
 */
const HARDEN_SOURCE = `(() => {
  const drop = (object, key) => {
    try {
      delete object[key];
    } catch {}
  };
  for (const name of ['eval', 'Function', 'SharedArrayBuffer', 'Atomics', 'WebAssembly']) drop(globalThis, name);
  for (const constructor of [
    Object.getPrototypeOf(function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(async function* () {}),
  ]) drop(constructor, 'constructor');
})()`;

const harden = (context: QuickJSContext): void => {
  context.unwrapResult(context.evalCode(HARDEN_SOURCE)).dispose();
};

type Codec = { encode: QuickJSHandle; decode: QuickJSHandle };

/** One codec per context; its handles die with the context. */
const guestCodec = (context: QuickJSContext): Codec => {
  const kit = context.unwrapResult(context.evalCode(CODEC_SOURCE));
  const encode = context.getProp(kit, 'encode');
  const decode = context.getProp(kit, 'decode');
  kit.dispose();
  return { encode, decode };
};

const marshalOut = (context: QuickJSContext, codec: Codec, handle: QuickJSHandle): unknown => {
  const encoded = context.callFunction(codec.encode, context.undefined, handle);
  if (encoded.error) {
    const dumped = context.dump(encoded.error) as DumpedError;
    encoded.error.dispose();
    throw new SerializationError(dumped.message);
  }
  const json = context.getString(encoded.value);
  encoded.value.dispose();
  return decodeTree(JSON.parse(json));
};

/** §14.3-3: a host function crosses as a guest function, a returned promise as a guest promise. */
const bridgedPromises = new WeakMap<QuickJSContext, Set<QuickJSDeferredPromise>>();
/** A bridge that settles after its context died has nothing to hand back, and no handle to mint. */
const ABANDONED = new Promise<never>(() => {});

const bridgeHostFunction = (context: QuickJSContext, codec: Codec, fn: (...args: never[]) => unknown): QuickJSHandle =>
  context.newFunction(fn.name || 'hostFunction', (...argHandles) => {
    const result = fn(...(argHandles.map((arg) => marshalOut(context, codec, arg)) as never[]));
    if (!(result instanceof Promise)) return marshalIn(context, codec, result);
    const deferred = context.newPromise(
      result.then(
        (value): QuickJSHandle | Promise<never> => (context.alive ? marshalIn(context, codec, value) : ABANDONED),
        (error): never | Promise<never> => {
          // Settling after teardown must not reach into the dead context, so the bridge is left pending.
          if (!context.alive) return ABANDONED;
          throw error;
        },
      ),
    );
    let pending = bridgedPromises.get(context);
    if (!pending) bridgedPromises.set(context, (pending = new Set()));
    pending.add(deferred);
    // The engine's contract: a deferred that settles has its callbacks disposed by resolve/reject,
    // so only its promise handle is left to free.
    void deferred.settled.then(() => {
      if (pending.delete(deferred)) deferred.dispose();
    });
    return deferred.handle;
  });

/** A bridge the host never settled would abort `JS_FreeRuntime`; the guest promise dies with the context anyway. */
const dropBridgedPromises = (context: QuickJSContext): void => {
  const pending = bridgedPromises.get(context);
  if (!pending) return;
  bridgedPromises.delete(context);
  for (const deferred of pending) deferred.dispose();
};

const marshalIn = (context: QuickJSContext, codec: Codec, value: unknown): QuickJSHandle => {
  const functions: HostFunctions = [];
  const tree = context.newString(JSON.stringify(encodeTree(value, functions)));
  const proxies = context.newObject();
  functions.forEach((fn, index) => {
    const handle = bridgeHostFunction(context, codec, fn);
    context.setProp(proxies, String(index), handle);
    handle.dispose();
  });
  try {
    return context.unwrapResult(context.callFunction(codec.decode, context.undefined, tree, proxies));
  } finally {
    tree.dispose();
    proxies.dispose();
  }
};

// ── §14.2 module graph ─────────────────────────────────────────────────────

/** `import.meta.url` is the module name, so the entry's name has to be synthetic. */
const moduleUrl = (name: string): string => (name.startsWith('sandbox:') ? name : `sandbox:${name}`);

/** One spelling per module: `./a/../lib.js` and `./lib.js` are the same key. */
const canonicalSpecifier = (specifier: string): string =>
  specifier.startsWith('.') ? `./${posix.normalize(specifier).replace(/^\.\//, '')}` : specifier;

/** Resolve a relative specifier against its importer; leave bare and URL names to the loader. */
const resolveSpecifier = (base: string, requested: string): string => {
  if (!requested.startsWith('.')) return requested;
  const from = base.replace(/^sandbox:/, '');
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  return canonicalSpecifier(dir ? `${dir}/${requested}` : requested);
};

/** `could not load module '<name>'` is the shape both link paths already parse. */
const loadFailure = (name: string, detail?: string): Error =>
  new Error(`could not load module '${name}'${detail ? `: ${detail.replaceAll("'", '')}` : ''}`);

/** A loader failure arrives at link time or as a rejected dynamic import; both mean `link_error`. */
const linkFailure = (dumped: DumpedError, filename: string): CodeExecutionError | undefined => {
  const missingModule = /^could not load module '(.+)'/.exec(dumped.message);
  if (missingModule) return { name: dumped.name, message: dumped.message, specifier: missingModule[1], filename };
  // The status list puts a missing named export in `link_error`, not in `error`.
  const missingExport = /^Could not find export '(.+)' in module '(.+)'/.exec(dumped.message);
  return missingExport
    ? { name: dumped.name, message: dumped.message, specifier: missingExport[2], filename }
    : undefined;
};

/** §14.2: a bare specifier is a synthetic module over the marshaled namespace the channel holds. */
const syntheticModule = (name: string, namespace: Record<string, unknown>): string => {
  const specifier = JSON.stringify(name);
  const keys = Object.keys(namespace ?? {});
  const lines = [
    `const ns = globalThis.${MODULE_CHANNEL}[${specifier}];`,
    `delete globalThis.${MODULE_CHANNEL}[${specifier}];`,
    // An empty channel is deleted, so guest code never sees a namespace it did not import.
    `if (!Object.keys(globalThis.${MODULE_CHANNEL}).length) delete globalThis.${MODULE_CHANNEL};`,
  ];
  if (keys.includes('default')) lines.push('export default ns.default;');
  for (const key of keys) {
    // A key that is not an identifier cannot be a named export; callers import those through `default`.
    if (key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key)) lines.push(`export const ${key} = ns[${JSON.stringify(key)}];`);
  }
  return lines.join('\n');
};

/**
 * Bare specifiers resolve only from `imports`, relative only from `modules`, everything
 * else fails linkage. Returns the per-context namespace handles `evaluate` marshals.
 */
const installModuleGraph = (runtime: QuickJSRuntime, options: CodeExecutionOptions): Map<string, QuickJSHandle> => {
  const language = options.language ?? 'typescript';
  const modules = new Map(
    Object.entries(options.modules ?? {}).map(([specifier, source]) => [canonicalSpecifier(specifier), source]),
  );
  const imports = options.imports ?? {};
  const namespaces = new Map<string, QuickJSHandle>();
  runtime.setModuleLoader(
    (name, context) => {
      if (!name.startsWith('.')) {
        if (!Object.hasOwn(imports, name)) throw loadFailure(name);
        const namespace = namespaces.get(name);
        if (namespace === undefined) throw loadFailure(name, 'no context was prepared for this import');
        // The channel exists only between this call and the module body that empties it.
        let channel = context.getProp(context.global, MODULE_CHANNEL);
        if (context.typeof(channel) !== 'object') {
          channel.dispose();
          channel = context.newObject();
          context.setProp(context.global, MODULE_CHANNEL, channel);
        }
        context.setProp(channel, name, namespace);
        channel.dispose();
        return `import.meta.url = ${JSON.stringify(moduleUrl(name))};\n${syntheticModule(name, imports[name])}`;
      }
      const source = modules.get(name);
      if (source === undefined) throw loadFailure(name);
      try {
        const erased = language === 'typescript' ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
        return `import.meta.url = ${JSON.stringify(moduleUrl(name))};\n${erased}`;
      } catch (thrown) {
        throw loadFailure(name, thrown instanceof Error ? thrown.message : String(thrown));
      }
    },
    resolveSpecifier,
  );
  return namespaces;
};

type DumpedError = { name: string; message: string; stack?: string; lineNumber?: number };

const sandboxError = (dumped: DumpedError, filename: string, lineOffset: number): CodeExecutionError => {
  const error: CodeExecutionError = { name: dumped.name, message: dumped.message, filename };
  if (dumped.stack) error.stack = dumped.stack;
  const frame = /at [^\n]*?:(\d+):(\d+)/.exec(dumped.stack ?? '');
  if (dumped.lineNumber !== undefined) error.line = dumped.lineNumber - lineOffset;
  else if (frame) error.line = Number(frame[1]) - lineOffset;
  if (frame && error.line === Number(frame[1]) - lineOffset) error.column = Number(frame[2]);
  if (error.line !== undefined && error.line < 1) delete error.line;
  return error;
};

/** The eraser reports a source location only in the stack's code frame. */
const eraseFailure = (thrown: unknown, filename: string): CodeExecutionError => {
  const error = thrown as Error;
  const [header = '', , caret = ''] = String(error.stack ?? '').split('\n');
  const line = Number(/:(\d+)$/.exec(header)?.[1]);
  const column = caret.indexOf('^');
  return {
    name: error.name || 'SyntaxError',
    message: String(error.message ?? error),
    filename,
    ...(Number.isFinite(line) && line > 0 ? { line } : {}),
    ...(column >= 0 ? { column: column + 1 } : {}),
  };
};

/** What `handle.terminate()` recorded, read by the pump at every yield point. */
type Termination = { requested: boolean; reason?: string };

/** Pump guest jobs until the promise settles, then hand back its handle. */
const settle = async (
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  handle: QuickJSHandle,
  termination: Termination,
): Promise<{ value: QuickJSHandle } | { error: DumpedError } | { terminated: string }> => {
  const settled = context.resolvePromise(handle);
  let done = false;
  // A bridged host promise settles on the host queue, so the flag lets the pump stop as soon as the guest promise does.
  void settled.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    // §14.4: the batch boundary is the microtask yield point the caller's terminate() settles on.
    if (termination.requested) return { terminated: termination.reason ?? TERMINATED_BY_CALLER };
    const jobs = runtime.executePendingJobs(JOBS_PER_BATCH);
    if (jobs.error) {
      const error = context.dump(jobs.error) as DumpedError;
      jobs.error.dispose();
      return { error };
    }
    // A real event-loop turn, not a microtask: host work behind a bridged promise needs one.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await settled;
  if (result.error) {
    const error = context.dump(result.error) as DumpedError;
    result.error.dispose();
    return { error };
  }
  return { value: result.value };
};

const isThenable = (context: QuickJSContext, handle: QuickJSHandle): boolean => {
  const then = context.getProp(handle, 'then');
  const thenable = context.typeof(then) === 'function';
  then.dispose();
  return thenable;
};

class Execution implements CodeExecution {
  readonly reports: unknown[] = [];
  /** Read by the pump; the run settles on it at the next yield point. */
  readonly termination: Termination = { requested: false };
  #settled = false;
  #promise: Promise<CodeExecutionResult>;

  constructor(source: string, options: CodeExecutionOptions) {
    this.#promise = execute(source, options, this).finally(() => {
      this.#settled = true;
    });
  }

  get running(): boolean {
    return !this.#settled;
  }

  /** §14.4: sets a flag the pump reads; calls after the first, or after settlement, are no-ops. */
  terminate(reason?: string): void {
    if (this.#settled || this.termination.requested) return;
    this.termination.requested = true;
    this.termination.reason = reason;
  }

  then<TResult1 = CodeExecutionResult, TResult2 = never>(
    onfulfilled?: ((value: CodeExecutionResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }
}

export function run(source: string, options: CodeExecutionOptions = {}): CodeExecution {
  return new Execution(source, options);
}

async function execute(source: string, options: CodeExecutionOptions, handle: Execution): Promise<CodeExecutionResult> {
  const started = Date.now();
  const filename = options.filename ?? DEFAULT_FILENAME;
  const logs: CodeExecutionLog[] = [];
  const finish = (
    status: CodeExecutionStatus,
    extra: { result?: unknown; error?: CodeExecutionError } = {},
  ): CodeExecutionResult => ({
    status,
    ...extra,
    reports: [...handle.reports],
    logs,
    durationMs: Date.now() - started,
  });

  // §14.6: types are erased before evaluation, never checked.
  let code = source;
  if ((options.language ?? 'typescript') === 'typescript') {
    try {
      code = stripTypeScriptTypes(source, { mode: 'strip' });
    } catch (thrown) {
      return finish('error', { error: eraseFailure(thrown, filename) });
    }
  }

  const QuickJS = await engine;
  const runtime = QuickJS.newRuntime();
  // §14.4: a request above the module ceiling is clamped, and the message names the effective limit.
  const memoryLimitBytes = Math.min(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES, MEMORY_CEILING_BYTES);
  runtime.setMemoryLimit(memoryLimitBytes);
  const namespaces = installModuleGraph(runtime, options);
  const context = runtime.newContext();
  let codec: Codec | undefined;
  try {
    codec = guestCodec(context);
    harden(context);
    return await evaluate({
      context,
      runtime,
      codec,
      namespaces,
      code,
      options,
      filename,
      logs,
      memoryLimitBytes,
      termination: handle.termination,
      finish,
    });
  } finally {
    dropBridgedPromises(context);
    codec?.encode.dispose();
    codec?.decode.dispose();
    for (const namespace of namespaces.values()) namespace.dispose();
    context.dispose();
    runtime.dispose();
  }
}

async function evaluate(args: {
  context: QuickJSContext;
  runtime: QuickJSRuntime;
  codec: Codec;
  namespaces: Map<string, QuickJSHandle>;
  code: string;
  options: CodeExecutionOptions;
  filename: string;
  logs: CodeExecutionLog[];
  memoryLimitBytes: number;
  termination: Termination;
  finish: (status: CodeExecutionStatus, extra?: { result?: unknown; error?: CodeExecutionError }) => CodeExecutionResult;
}): Promise<CodeExecutionResult> {
  const { context, runtime, codec, namespaces, code, options, filename, logs, memoryLimitBytes, termination, finish } = args;
  const globals = options.globals ?? {};
  const captured = !('console' in globals);
  const names = [...Object.keys(globals), ...(captured ? ['console'] : [])];
  const imports = options.imports ?? {};

  // §14.2: import namespaces are marshaled before the entry module runs; the loader
  // puts each on the channel just before its synthetic module reads it.
  for (const [name, namespace] of Object.entries(imports)) {
    namespaces.set(name, marshalIn(context, codec, namespace ?? {}));
  }

  // §14.1: globals are module scope, so the entry module gets them as consts and
  // globalThis keeps only intrinsics once the module has started.
  if (names.length) {
    const bindings = context.newObject();
    try {
      for (const [name, value] of Object.entries(globals)) {
        const binding = marshalIn(context, codec, value);
        context.setProp(bindings, name, binding);
        binding.dispose();
      }
      if (captured) {
        const consoleHandle = context.newObject();
        for (const level of CONSOLE_LEVELS) {
          const sink = context.newFunction(level, (...argHandles) => {
            logs.push({ level, args: argHandles.map((arg) => marshalOut(context, codec, arg)), timestamp: Date.now() });
            return context.undefined;
          });
          context.setProp(consoleHandle, level, sink);
          sink.dispose();
        }
        context.setProp(bindings, 'console', consoleHandle);
        consoleHandle.dispose();
      }
      context.setProp(context.global, BINDINGS, bindings);
    } finally {
      bindings.dispose();
    }
  }

  const prefix = [
    // QuickJS leaves `import.meta` empty; §14.2 makes the URL synthetic and host-path free.
    `import.meta.url = ${JSON.stringify(moduleUrl(filename))};`,
    names.length ? `const { ${names.join(', ')} } = ${BINDINGS};` : '',
  ].filter(Boolean).join('\n') + '\n';
  const lineOffset = prefix.split('\n').length - 1;
  const outcome = context.evalCode(prefix + code, moduleUrl(filename), { type: 'module' });
  if (names.length) context.unwrapResult(context.evalCode(`delete globalThis.${BINDINGS}`)).dispose();
  if (Object.keys(imports).length) {
    context.unwrapResult(context.evalCode(`delete globalThis.${MODULE_CHANNEL}`)).dispose();
  }

  const memoryFailure = (dumped: DumpedError): CodeExecutionResult | undefined =>
    dumped.name === 'InternalError' && dumped.message === OUT_OF_MEMORY
      ? finish('memory', {
          error: { name: dumped.name, message: `${OUT_OF_MEMORY}: memory limit ${memoryLimitBytes} bytes` },
        })
      : undefined;

  const finishFailure = (dumped: DumpedError): CodeExecutionResult => {
    const memory = memoryFailure(dumped);
    if (memory) return memory;
    const link = linkFailure(dumped, filename);
    return link ? finish('link_error', { error: link }) : finish('error', { error: sandboxError(dumped, filename, lineOffset) });
  };

  if (outcome.error) {
    const dumped = context.dump(outcome.error) as DumpedError;
    outcome.error.dispose();
    return finishFailure(dumped);
  }

  const terminatedResult = (message: string): CodeExecutionResult =>
    finish('terminated', { error: { name: 'Error', message } });

  let moduleValue = outcome.value;
  if (isThenable(context, moduleValue)) {
    const awaited = await settle(context, runtime, moduleValue, termination);
    moduleValue.dispose();
    if ('terminated' in awaited) return terminatedResult(awaited.terminated);
    if ('error' in awaited) return finishFailure(awaited.error);
    moduleValue = awaited.value;
  }

  // §14.5: pick the export, call it if it is a function, await what it returns.
  const select = options.execute?.fn ?? 'default';
  const callArgs = options.execute?.args ?? [];
  let value = context.getProp(moduleValue, select);
  if (context.typeof(value) === 'undefined') {
    // An exported `undefined` is a value, not a missing export; only `in` tells them apart.
    const probe = context.unwrapResult(context.evalCode('(ns, key) => key in ns'));
    const key = context.newString(select);
    const present = context.callFunction(probe, context.undefined, moduleValue, key);
    probe.dispose();
    key.dispose();
    const missing = present.error ? true : context.dump(present.value) !== true;
    if (present.error) present.error.dispose();
    else present.value.dispose();
    if (missing) {
      value.dispose();
      moduleValue.dispose();
      return finish('link_error', {
        error: { name: 'TypeError', message: `module does not export '${select}'`, filename, specifier: select },
      });
    }
  }
  moduleValue.dispose();
  if (context.typeof(value) === 'function') {
    const argHandles = callArgs.map((arg) => marshalIn(context, codec, arg));
    const called = context.callFunction(value, context.undefined, ...argHandles);
    for (const arg of argHandles) arg.dispose();
    value.dispose();
    if (called.error) {
      const dumped = context.dump(called.error) as DumpedError;
      called.error.dispose();
      return memoryFailure(dumped) ?? finish('error', { error: sandboxError(dumped, filename, lineOffset) });
    }
    value = called.value;
  } else if (callArgs.length) {
    value.dispose();
    return finish('error', {
      error: { name: 'TypeError', message: `export '${select}' is not a function, so args must be empty`, filename },
    });
  }

  if (isThenable(context, value)) {
    const awaited = await settle(context, runtime, value, termination);
    value.dispose();
    if ('terminated' in awaited) return terminatedResult(awaited.terminated);
    if ('error' in awaited) return finishFailure(awaited.error);
    value = awaited.value;
  }

  try {
    return finish('success', { result: marshalOut(context, codec, value) });
  } finally {
    // A value that cannot cross throws; the handle still has to die or the engine aborts on dispose.
    value.dispose();
  }
}
