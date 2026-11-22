import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'summarize',
  toolDescription: 'Summarize the supplied text.',
  prompt: 'Summarize the input in one sentence.',
  model: 'scripted',
  tools: [],
});
