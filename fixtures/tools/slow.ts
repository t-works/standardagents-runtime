import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Occupy the thread for a while and record how many tool calls overlapped.',
  args: z.object({ ms: z.number().int().nonnegative().default(50) }),
  async execute(state, args) {
    const inFlight = ((await state.getValue<number>('tools.inFlight')) ?? 0) + 1;
    await state.setValue('tools.inFlight', inFlight);
    const peak = Math.max((await state.getValue<number>('tools.maxInFlight')) ?? 0, inFlight);
    await state.setValue('tools.maxInFlight', peak);
    await new Promise((resolve) => setTimeout(resolve, args.ms));
    await state.setValue('tools.inFlight', inFlight - 1);
    await append(state, 'tools.log', { name: 'slow', value: args.ms });
    return { status: 'success', result: 'slept ' + args.ms };
  },
});
