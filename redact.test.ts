import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { RuntimeEvent } from './contract.ts';
import { loadSource } from './loader.ts';
import { Runtime } from './runtime.ts';
import { ThreadStore } from './store.ts';
import { redactEnvValues } from './util.ts';

const SECRET = 's3cret-not-for-model';
const FIXTURES = pathToFileURL(path.resolve(import.meta.dirname, 'fixtures')).href;

test('masks secret values, keeps text values, and masks short secrets whole', () => {
  const env = { API_TOKEN: SECRET, LABEL: 'qa', PIN: '1234', EMPTY: '' };
  const types = { API_TOKEN: 'secret', LABEL: 'text', PIN: 'secret', EMPTY: 'secret' } as const;
  const out = redactEnvValues(env, types, `token=${SECRET} qa=qa pin=1234`);
  assert.equal(out, 'token=[redacted:API_TOKEN] qa=qa pin=[redacted:PIN]');
});

test('masks the longer secret first so a nested secret is not half-masked', () => {
  const env = { SHORT: 'abc', LONG: 'abc-def' };
  assert.equal(redactEnvValues(env, {}, 'x abc-def y'), 'x [redacted:LONG] y');
});

test('tool results and emitted events come back masked, text values visible', async () => {
  const { registry } = await loadSource(new URL(FIXTURES).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const root = mkdtempSync(path.join(tmpdir(), 'sa-redact-'));
  const events: RuntimeEvent[] = [];
  try {
    const runtime = new Runtime({
      store: new ThreadStore(root, { keyFile: path.join(root, 'store.key') }),
      registry,
      onEvent: (event) => events.push(event),
      instanceEnv: (name) => (name === 'OPENAI_API_KEY' ? 'dummy' : undefined),
    });
    const thread = await runtime.createThread({ agentId: 'probe' });
    await thread.setEnv('LEAF_SECRET', SECRET);
    await thread.setEnv('LEAF_LABEL', 'qa', { type: 'text' });

    const probed = await runtime.invokeTool(thread, 'state_probe', { env: ['LEAF_SECRET', 'LEAF_LABEL'] });
    assert.equal(probed.status, 'success');
    const text = probed.result ?? '';
    assert.ok(!text.includes(SECRET), 'tool result must not carry the secret');
    assert.ok(text.includes('[redacted:LEAF_SECRET]'));
    assert.ok(text.includes('"LEAF_LABEL":"qa"'), 'text-classified values stay visible');

    // The KV write stays raw: redaction is an output concern, so evals can observe
    // what the tool actually resolved without depending on a mask format.
    assert.deepEqual(await thread.getValue('state.env'), { LEAF_SECRET: SECRET, LEAF_LABEL: 'qa' });

    runtime.emit(thread, 'tick', { note: `uses ${SECRET}` });
    const emitted = events.find((event) => event.type === 'event');
    assert.deepEqual(emitted, { type: 'event', threadId: thread.threadId, event: 'tick', data: { note: 'uses [redacted:LEAF_SECRET]' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
