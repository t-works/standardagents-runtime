import { defineHook } from '@standardagents/spec';
import { append } from '../tools/_log.ts';

export default defineHook({
  hook: 'filter_messages',
  id: 'pipeline_filter_messages',
  async execute(state, messages) {
    await append(state, 'hooks.log', { hook: 'filter_messages', id: 'pipeline_filter_messages' });
    return messages;
  },
});
