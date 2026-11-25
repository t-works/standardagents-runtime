import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'vision_probe',
  description: 'Prompt-backed probe whose model declares image support.',
  toolDescription: 'Baseline vision probe',
  primary: true,
  maxSessionTurns: 2,
  sideA: { prompt: 'vision_prompt', maxSteps: 2, stopOnResponse: true },
  sideB: { human: true },
});
