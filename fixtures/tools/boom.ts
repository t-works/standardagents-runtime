import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Fail on purpose, either by throwing or by returning an error result.',
  args: z.object({
    message: z.string().optional(),
    mode: z.enum(['throw', 'result']).optional(),
  }),
  async execute(state, args) {
    const message = args.message ?? 'probe failure';
    await append(state, 'tools.log', { name: 'boom', value: message });
    if (args.mode === 'result') return { status: 'error', error: message };
    throw new Error(message);
  },
});
