import { defineTool } from '@standardagents/spec';
import { append } from './_log.ts';

export default defineTool({
  description: 'Stop the current execution through the stopTool binding.',
  async execute(state) {
    await append(state, 'tools.log', { name: 'stop_now', value: null });
    return { status: 'success', result: 'stop requested' };
  },
});
