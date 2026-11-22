import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Mark the active session terminal through state.stopSession.',
  args: z.object({ result: z.string().optional() }),
  async execute(state, args) {
    await append(state, 'tools.log', { name: 'session_stop', value: args.result ?? null });
    await state.stopSession(args.result === undefined ? undefined : { result: args.result });
    return { status: 'success', result: 'session stopped' };
  },
});
