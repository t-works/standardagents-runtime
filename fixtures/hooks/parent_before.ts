import { defineHook } from '@standardagents/spec';
import { append } from '../tools/_log.ts';

export default defineHook({
  hook: 'after_system_message',
  id: 'parent_probe_before',
  async execute(state, systemMessage) {
    await append(state, 'hooks.log', { hook: 'after_system_message', id: 'parent_probe_before' });
    return systemMessage;
  },
});
