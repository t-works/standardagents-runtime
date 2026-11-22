import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Check whether a path exists in THIS thread filesystem and record the answer.',
  args: z.object({ path: z.string() }),
  async execute(state, args) {
    const file = await state.statFile(args.path);
    const snapshot = { path: args.path, exists: file !== null };
    await append(state, 'tools.log', { name: 'file_probe', value: snapshot });
    return { status: 'success', result: JSON.stringify(snapshot) };
  },
});
