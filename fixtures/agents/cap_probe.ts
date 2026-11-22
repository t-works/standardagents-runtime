import { defineAgent } from '@standardagents/spec';

// One capped relationship and no immediate children, so the registry count is
// the cap and nothing else. Keep it that way: any `immediate` child makes the
// `children` assertion in sub-04 count something the cap does not control.
export default defineAgent({
  name: 'cap_probe',
  description: 'Parent with a single maxInstances-capped relationship and no immediate children.',
  toolDescription: 'Capped subagent parent',
  primary: false,
  maxSessionTurns: 4,
  sideA: {
    prompt: 'orchestrator_prompt',
    maxSteps: 4,
    stopOnResponse: true,
    subagents: [{ agent: 'worker', as: 'limited_worker', maxInstances: 2, initUserMessageProperty: 'task' }],
  },
  sideB: { human: true },
});
