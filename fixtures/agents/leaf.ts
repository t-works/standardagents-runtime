import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'leaf',
  description: 'Leaf child used for hidden, optional, immediate, and recursion probes.',
  toolDescription: 'Leaf child',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 2,
  sideA: { prompt: 'leaf_prompt', maxSteps: 2, stopOnResponse: true },
  sideB: { human: true },
});
