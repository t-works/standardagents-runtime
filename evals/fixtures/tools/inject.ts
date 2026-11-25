import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Inject a message after the current request snapshot was taken.',
  args: z.object({ content: z.string(), silent: z.boolean().optional() }),
  async execute(state, args) {
    await state.injectMessage({ role: 'user', content: args.content, silent: args.silent ?? false });
    await append(state, 'tools.log', { name: 'inject', value: args.content });
    return { status: 'success', result: 'injected' };
  },
});
