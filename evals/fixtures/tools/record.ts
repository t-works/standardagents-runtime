import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Append a marker to tools.log. Used to observe execution order and arguments.',
  args: z.object({ value: z.string() }),
  async execute(state, args) {
    await append(state, 'tools.log', { name: 'record', value: args.value });
    return { status: 'success', result: 'recorded ' + args.value };
  },
});
