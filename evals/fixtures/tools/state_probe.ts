import { defineTool } from '@standardagents/spec';
import { z } from 'zod';
import { append } from './_log.ts';

export default defineTool({
  description: 'Record the thread state a runtime exposes: arguments, parent, status, children, selected env.',
  args: z.object({ env: z.array(z.string()).optional() }),
  async execute(state, args) {
    const parent = await state.getParentThread();
    const env: Record<string, string | null> = {};
    for (const name of args.env ?? []) {
      try {
        env[name] = await state.env(name);
      } catch {
        env[name] = null;
      }
    }
    const snapshot = {
      arguments: state.arguments,
      parentThreadId: parent?.threadId ?? null,
      terminated: state.terminated,
      children: state.children.map((child) => ({
        relationship: child.relationship,
        name: child.name,
        status: child.status,
        parentCommunication: child.parentCommunication ?? null,
      })),
      env,
    };
    await state.setValue('state.snapshot', snapshot);
    await state.setValue('state.env', env);
    await append(state, 'tools.log', { name: 'state_probe', value: snapshot });
    return { status: 'success', result: JSON.stringify(snapshot) };
  },
});
