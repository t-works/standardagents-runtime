import { defineAgent } from '@standardagents/spec';

/** Parent for the fail-closed probe; its child requires a user-scope hook. */
export default defineAgent({
  name: 'parent',
  description: 'Broken fixture parent: its child requires a user-scope hook.',
  toolDescription: 'Broken fixture parent',
  primary: true,
  maxSessionTurns: 4,
  sideA: {
    prompt: 'parent_prompt',
    maxSteps: 1,
    stopOnResponse: true,
    subagents: [{ agent: 'kid', as: 'kid' }],
  },
  sideB: { human: true },
});
