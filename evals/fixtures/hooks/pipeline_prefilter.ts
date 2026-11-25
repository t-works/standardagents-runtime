import { defineHook } from '@standardagents/spec';
import { append } from '../tools/_log.ts';

export default defineHook({
  hook: 'prefilter_llm_history',
  id: 'pipeline_prefilter',
  async execute(state, messages) {
    await append(state, 'hooks.log', { hook: 'prefilter_llm_history', id: 'pipeline_prefilter' });
    return messages;
  },
});
