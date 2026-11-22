import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'probe_prompt',
  toolDescription: 'Baseline prompt probe',
  prompt: 'You are the baseline runtime probe. Follow the tool directives in the newest user message.',
  model: 'scripted',
  includeChat: true,
  tools: [
    'record',
    'boom',
    'stop_now',
    'slow',
    'inject',
    'session_stop',
    'escalate',
    'kv',
    'state_probe',
    'drop_file',
    'file_probe',
    'run_code',
    'summarize',
    'handler_probe',
  ],
  hooks: ['pipeline_after_system', 'pipeline_filter_messages', 'pipeline_prefilter'],
});
