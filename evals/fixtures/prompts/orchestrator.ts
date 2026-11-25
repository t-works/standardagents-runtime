import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'orchestrator_prompt',
  toolDescription: 'Baseline subagent orchestrator',
  prompt: 'You are the baseline orchestrator. Use the lifecycle tools to manage children.',
  model: 'scripted',
  includeChat: true,
  tools: ['record', 'kv', 'state_probe', 'drop_file', 'summarize', 'handler_probe'],
  hooks: ['pipeline_after_system', 'parent_own', 'pipeline_filter_messages', 'pipeline_prefilter'],
});
