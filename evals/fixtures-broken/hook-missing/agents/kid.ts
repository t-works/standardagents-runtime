import { defineAgent } from '@standardagents/spec';

/** Child that requires a parent hook no definition provides: the load must fail closed. */
export default defineAgent({
  name: 'kid',
  description: 'Broken fixture child requiring the hook id no_such_hook.',
  toolDescription: 'Broken fixture child',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 2,
  parentHooks: [{ hook: 'no_such_hook', reason: 'Probe that an unloadable requirement fails closed', stage: 'after_parent' }],
  sideA: { prompt: 'kid_prompt', maxSteps: 1, stopOnResponse: false },
  sideB: { human: true },
});
