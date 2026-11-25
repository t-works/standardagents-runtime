import { definePrompt } from '@standardagents/spec';

export default definePrompt({
  name: 'dual_b_prompt',
  toolDescription: 'Dual-prompt probe, side B',
  prompt: 'You are side B of the dual-prompt probe.',
  model: 'scripted_dual',
  includeChat: true,
  // The point of the probe is that own past calls survive and the other side's do not.
  includePastTools: true,
  tools: ['record'],
});
