import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Exercise the durable per-thread key-value store: set, get, or delete one key.',
  args: z.object({
    op: z.enum(['set', 'get', 'delete']),
    key: z.string(),
    value: z.unknown().optional(),
  }),
  async execute(state, args) {
    if (args.op !== 'get') await state.setValue(args.key, args.op === 'delete' ? null : (args.value ?? null));
    const value = await state.getValue(args.key);
    await append(state, 'tools.log', { name: 'kv', value: { op: args.op, key: args.key } });
    return { status: 'success', result: JSON.stringify(value ?? null) };
  },
});
