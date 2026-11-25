import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'handler_probe',
  description: 'Handler-backed side; also exposed as an agent handoff tool.',
  toolDescription: 'Hand a task to the handler probe',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 2,
  sideA: { handler: 'echo' },
  sideB: { human: true },
});
