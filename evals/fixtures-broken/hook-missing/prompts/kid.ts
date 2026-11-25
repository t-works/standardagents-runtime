import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'kid_prompt',
  toolDescription: 'Broken fixture child',
  prompt: 'You are the broken fixture child.',
  model: 'scripted',
  includeChat: true,
});
