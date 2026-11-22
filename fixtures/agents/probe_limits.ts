import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'probe_limits',
  description: 'Probe limited by maxSteps, with no response stop.',
  toolDescription: 'maxSteps probe',
  primary: false,
  maxSessionTurns: 8,
  sideA: { prompt: 'probe_prompt', maxSteps: 2 },
  sideB: { human: true },
});
