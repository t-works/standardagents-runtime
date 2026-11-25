import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'worker',
  description: 'Child worker that declares required parent hooks and an immediate leaf child.',
  toolDescription: 'Delegate a task to a worker',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 4,
  sideA: {
    prompt: 'worker_prompt',
    maxSteps: 4,
    stopOnResponse: true,
    subagents: [{ agent: 'leaf', as: 'worker_leaf', immediate: true }],
  },
  sideB: { human: true },
});
