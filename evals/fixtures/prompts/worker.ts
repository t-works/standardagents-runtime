import { definePrompt } from '@standardagents/spec';
import { z } from 'zod';

export default definePrompt({
  name: 'worker_prompt',
  toolDescription: 'Baseline child worker',
  prompt: 'You are a worker. Task: {{task}}',
  model: 'scripted',
  includeChat: true,
  requiredSchema: z.object({
    task: z.string(),
    attachments: z.array(z.string()).optional(),
    label: z.string().optional(),
  }),
  tools: ['record', 'kv', 'state_probe', 'file_probe', 'drop_file', 'escalate', 'session_stop'],
  hooks: ['pipeline_after_system', 'pipeline_filter_messages', 'pipeline_prefilter'],
});
