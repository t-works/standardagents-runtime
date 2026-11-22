import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'probe',
  description: 'Prompt-backed baseline probe for execution, tools, stops, queue, and runCode.',
  toolDescription: 'Baseline runtime probe',
  primary: true,
  maxSessionTurns: 8,
  sideA: {
    prompt: 'probe_prompt',
    maxSteps: 4,
    stopOnResponse: true,
    stopTool: 'stop_now',
    sessionStop: { name: 'session_stop', messageProperty: 'result' },
  },
  sideB: { human: true },
});
