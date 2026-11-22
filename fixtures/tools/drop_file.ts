import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Write a file into the current thread filesystem, for attachment-copy checks.',
  args: z.object({ path: z.string(), content: z.string().default('probe-file') }),
  async execute(state, args) {
    await state.writeFile(args.path, args.content, 'text/plain');
    await append(state, 'tools.log', { name: 'drop_file', value: args.path });
    return { status: 'success', result: 'wrote ' + args.path };
  },
});
