import { defineAgent } from '@standardagents/spec';

/**
 * Two prompt-backed sides and no subagents: both sides always have a turn, so
 * the request sequence alternates and is deterministic. `stopOnResponse: false`
 * with `maxSteps: 1` makes each turn exactly one model call, which is what lets
 * `api-12` count turns and `api-11` index the requests by side.
 */
export default defineAgent({
  name: 'dual_agent',
  description: 'Both sides prompt-backed, one model call per turn.',
  toolDescription: 'Dual-prompt probe',
  primary: true,
  maxSessionTurns: 4,
  sideA: { prompt: 'dual_a_prompt', maxSteps: 1, stopOnResponse: false },
  sideB: { prompt: 'dual_b_prompt', maxSteps: 1, stopOnResponse: false },
});
