import { defineHandler } from '@standardagents/spec';

export default defineHandler({
  description: 'Records the inbound message and injects a deterministic reply.',
  async execute(state, message) {
    const turns = ((await state.getValue<number>('handler.turns')) ?? 0) + 1;
    await state.setValue('handler.turns', turns);
    await state.setValue('handler.lastContent', message.content ?? '');
    await state.injectMessage({ role: 'assistant', content: 'handler:' + (message.content ?? '') });
  },
});
