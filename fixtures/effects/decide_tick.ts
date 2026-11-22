import { defineEffect } from '@standardagents/spec';
import type { DecisionProviderFactory } from '@standardagents/spec';

// shortcut: answers are statically shaped here, so the literal cast is enough; widen if questions grow.
const provider: DecisionProviderFactory = (() => ({
  name: 'probe-decision',
  specificationVersion: '1',
  kind: 'decision',
  async decide(request) {
    return {
      model: request.model,
      answers: { ok: { type: 'boolean', probability: 1 } },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } as never;
  },
})) as DecisionProviderFactory;

/** decide() must work outside conversation execution, so probe it from an effect. */
export default defineEffect('Call ThreadState.decide while no execution is running.', async (state) => {
  const executionIsNull = state.execution == null;
  const decision = await state.decide({
    model: 'scripted',
    context: 'Independent decision probe',
    questions: { ok: { type: 'boolean', instructions: 'Is the runtime reachable?' } },
    provider,
  });
  const probability = (decision.answers as { ok: { probability: number } }).ok.probability;
  const log = (await state.getValue<unknown[]>('decisions.log')) ?? [];
  log.push({ executionIsNull, probability });
  await state.setValue('decisions.log', log);
  const ticks = (await state.getValue<unknown[]>('effects.log')) ?? [];
  ticks.push({ effect: 'decide_tick', at: Date.now() });
  await state.setValue('effects.log', ticks);
});
