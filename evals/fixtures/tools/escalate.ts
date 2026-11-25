import { defineTool } from '@standardagents/spec';
import { append } from './_log.ts';

export default defineTool({
  description: 'Escalate to the parent: notifyParent plus setStatus. No-ops safely without a parent.',
  async execute(state) {
    await state.notifyParent('escalate:child-message');
    await state.setStatus('escalated');
    await append(state, 'tools.log', { name: 'escalate', value: null });
    return { status: 'success', result: 'escalated' };
  },
});
