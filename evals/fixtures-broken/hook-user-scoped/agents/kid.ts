import { defineAgent } from '@standardagents/spec';

/**
 * Child that requires a user-scope hook on its parent. A user-scope hook can
 * never compose onto a thread, so the load must fail closed even though the id
 * resolves (see factory/bugs/parent-hook-user-scope-skipped.md).
 */
export default defineAgent({
  name: 'kid',
  description: 'Broken fixture child requiring the user-scope hook track_presence.',
  toolDescription: 'Broken fixture child',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 2,
  parentHooks: [{ hook: 'track_presence', reason: 'Probe that a user-scoped requirement fails closed', stage: 'after_parent' }],
  sideA: { prompt: 'kid_prompt', maxSteps: 1, stopOnResponse: false },
  sideB: { human: true },
});
