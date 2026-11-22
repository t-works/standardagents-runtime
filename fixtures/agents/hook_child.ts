import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'hook_child',
  description: 'Child that requires hooks on every direct parent. Declared by exactly one relationship so composition order is unambiguous.',
  toolDescription: 'Hook composition child',
  primary: false,
  exposeAsTool: true,
  maxSessionTurns: 2,
  parentHooks: [
    { hook: 'parent_probe_before', reason: 'Probe before-parent composition order', stage: 'before_parent' },
    { hook: 'parent_probe_after', reason: 'Probe after-parent composition order', stage: 'after_parent' },
  ],
  sideA: { prompt: 'leaf_prompt', maxSteps: 2, stopOnResponse: true },
  sideB: { human: true },
});
