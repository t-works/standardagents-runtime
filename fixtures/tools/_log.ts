import type { ThreadState } from '@standardagents/spec';

/** Append one value to a durable list on the thread - the fixture's observation log. */
export async function append(state: ThreadState, key: string, value: unknown): Promise<unknown[]> {
  const list = (await state.getValue<unknown[]>(key)) ?? [];
  list.push(value);
  await state.setValue(key, list);
  return list;
}
