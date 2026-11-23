import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from './contract.ts';
import { loadSource } from './loader.ts';
import { Runtime } from './runtime.ts';
import { ThreadStore } from './store.ts';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

/**
 * One `onEvent` sink serves every live thread, so each event has to name the
 * thread it reports on. Without that, a host watching several threads can only
 * guess attribution from arrival order.
 */
test('every runtime event names the thread it reports on', async () => {
  const { registry } = await loadSource(FIXTURES);
  const root = mkdtempSync(path.join(tmpdir(), 'sa-events-'));
  const events: RuntimeEvent[] = [];
  try {
    const store = new ThreadStore(root, { keyFile: path.join(root, 'store.key') });
    const runtime = new Runtime({
      store,
      registry,
      onEvent: (event) => events.push(event),
      instanceEnv: (name) => (name === 'OPENAI_API_KEY' ? 'dummy' : undefined),
    });

    // createThread spawns the orchestrator's immediate children, which is the
    // subagent path; the probe thread then runs a model turn with one tool call.
    await runtime.createThread({ agentId: 'orchestrator' });
    await runtime.settle();
    const orchestrated = store.list().find((record) => record.agent_id === 'orchestrator')!;
    // A child reporting its own status must point at the parent entry it changed.
    const child = runtime.threadFor(store.load(orchestrated.children[0].reference)!);
    await child.setStatus('idle');

    const thread = await runtime.createThread({ agentId: 'probe' });
    await thread.queueMessage({ role: 'user', content: 'go [[tool:record {"value":"one"}]] [[once]]' });
    await runtime.settle();

    runtime.emit(thread, 'tick', { note: 'observability' });
    await thread.scheduleEffect('tick', {});
    await runtime.drainDueEffects(thread);

    const records = store.list();
    const transcripts = new Map(records.map((record) => [record.id, store.loadMessages(record.id)]));
    assert.ok(records.length >= 3, 'orchestrator, its children and the probe thread are stored');

    for (const event of events) {
      assert.ok(event.threadId, `${event.type} carries a threadId`);
      assert.ok(transcripts.has(event.threadId), `${event.type} names a thread in the store`);
    }

    // A message event belongs to the thread whose transcript holds that message.
    for (const event of events) {
      if (event.type !== 'message' && event.type !== 'message_updated') continue;
      const owner = [...transcripts].find(([, rows]) => rows.some((row) => row.id === event.message.id));
      assert.equal(event.threadId, owner?.[0], `${event.type} is attributed to its own transcript`);
    }

    // A subagent event reports on the parent whose children[] entry changed.
    for (const event of events) {
      if (event.type !== 'subagent') continue;
      const owner = records.find((record) => record.children.some((child) => child.reference === event.reference));
      assert.equal(event.threadId, owner?.id, 'subagent event is attributed to the parent entry it changed');
    }

    const types = new Set(events.map((event) => event.type));
    for (const type of ['message', 'status', 'tool_started', 'tool_done', 'subagent', 'effect', 'event'] as const) {
      assert.ok(types.has(type), `the run produced a ${type} event`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
