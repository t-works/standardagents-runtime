import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'leaf_prompt',
  toolDescription: 'Baseline leaf child',
  prompt: 'You are a leaf child. Do only what you are told.',
  model: 'scripted',
  includeChat: true,
  tools: ['record', 'state_probe'],
  hooks: ['pipeline_after_system', 'pipeline_filter_messages', 'pipeline_prefilter'],
});
