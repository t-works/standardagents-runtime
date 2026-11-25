import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'parent_prompt',
  toolDescription: 'Broken fixture parent',
  prompt: 'You are the broken fixture parent.',
  model: 'scripted',
  includeChat: true,
});
