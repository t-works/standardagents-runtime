import { defineHook } from '@standardagents/spec';
import { append } from '../tools/_log.ts';

export default defineHook({
  hook: 'after_system_message',
  id: 'pipeline_after_system',
  async execute(state, systemMessage) {
    await append(state, 'hooks.log', { hook: 'after_system_message', id: 'pipeline_after_system' });
    await state.setValue('system.current', systemMessage);
    return systemMessage;
  },
});
