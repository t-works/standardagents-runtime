import { defineEffect } from '@standardagents/spec';

export default defineEffect('Record a tick so scheduled-effect triggers are observable.', async (state) => {
  const log = (await state.getValue<unknown[]>('effects.log')) ?? [];
  log.push({ effect: 'tick', at: Date.now() });
  await state.setValue('effects.log', log);
});
