import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'vision_prompt',
  toolDescription: 'Baseline vision prompt',
  prompt: 'You are the baseline vision probe. Say what you see in the newest user message.',
  model: 'scripted_vision',
  includeChat: true,
});
