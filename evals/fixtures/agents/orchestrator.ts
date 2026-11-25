import { defineAgent } from '@standardagents/spec';

export default defineAgent({
  name: 'orchestrator',
  description: 'Baseline parent that declares every subagent relationship shape.',
  toolDescription: 'Baseline subagent orchestrator',
  primary: true,
  maxSessionTurns: 8,
  sideA: {
    prompt: 'orchestrator_prompt',
    maxSteps: 6,
    stopOnResponse: true,
    subagents: [
      {
        agent: 'worker',
        as: 'worker',
        maxInstances: 2,
        initUserMessageProperty: 'task',
        initAttachmentsProperty: 'attachments',
        initAgentNameProperty: 'label',
      },
      { agent: 'worker', as: 'quiet_worker', parentCommunication: 'explicit', initUserMessageProperty: 'task' },
      { agent: 'worker', as: 'blocking_worker', blocking: true, initAttachmentsProperty: 'attachments' },
      { agent: 'hook_child', as: 'hook_child' },
      { agent: 'leaf', as: 'hidden_leaf', hidden: true },
      { agent: 'leaf', as: 'optional_leaf', optional: 'OPTIONAL_LEAF' },
      {
        agent: 'leaf',
        as: 'env_leaf',
        immediate: { nameEnv: 'LEAF_NAME', descriptionEnv: 'LEAF_NAME', scopedEnv: ['LEAF_NAME', 'LEAF_SECRET'] },
      },
      { agent: 'leaf', as: 'immediate_leaf', immediate: true },
    ],
  },
  sideB: { human: true },
});
