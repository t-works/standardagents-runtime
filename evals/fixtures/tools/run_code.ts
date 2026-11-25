import { defineTool } from '@standardagents/spec';
import type { CodeExecutionOptions } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Run source through ThreadState.runCode and return the full CodeExecutionResult.',
  args: z.object({
    source: z.string(),
    options: z.record(z.string(), z.unknown()).optional(),
    terminateAfterMs: z.number().nonnegative().optional(),
    terminateReason: z.string().optional(),
  }),
  async execute(state, args) {
    const options = { ...((args.options ?? {}) as CodeExecutionOptions) };
    // The cases are JSON, so they cannot carry functions: the fixture owns the bridge.
    if (options.globals) options.globals = { setTimeout, ...options.globals };
    if (options.imports?.host) {
      options.imports = {
        ...options.imports,
        host: {
          ...options.imports.host,
          // Settles on a real turn, so code-06 proves `await` crosses the boundary rather than a microtask.
          double: (n: number) => new Promise<number>((resolve) => setImmediate(() => resolve(n * 2))),
          // code-15 asks whether the sandbox can hand a host receiver to a bridged call.
          read(this: unknown) {
            return this === undefined ? 'no-this' : 'stolen-this';
          },
        },
      };
    }
    const handle = state.runCode(args.source, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (args.terminateAfterMs !== undefined) {
      timer = setTimeout(() => {
        handle.terminate(args.terminateReason);
        // A second call must be a no-op: terminate is idempotent.
        handle.terminate(args.terminateReason);
      }, args.terminateAfterMs);
    }
    try {
      const result = await handle;
      await append(state, 'runCode.log', result);
      return { status: 'success', result: JSON.stringify(result) };
    } catch (error) {
      const thrown = error instanceof Error ? error.message : String(error);
      await append(state, 'runCode.log', { thrown });
      return { status: 'error', error: 'runCode rejected: ' + thrown };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
});
