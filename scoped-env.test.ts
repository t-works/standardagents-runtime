import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadSource } from './loader.ts';
import { Runtime } from './runtime.ts';
import { ThreadStore } from './store.ts';

const SECRET = 's3cret-not-for-model';
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

test('immediate-object scopedEnv reaches the child, and only the declared child', async () => {
  const { registry } = await loadSource(FIXTURES);
  const root = mkdtempSync(path.join(tmpdir(), 'sa-scoped-'));
  const store = new ThreadStore(root, { keyFile: path.join(root, 'store.key') });
  try {
    const runtime = new Runtime({
      store,
      registry,
      instanceEnv: (name) =>
        ({ LEAF_NAME: 'probe-leaf', LEAF_SECRET: SECRET, OPENAI_API_KEY: 'dummy' })[name],
    });
    const parent = await runtime.createThread({ agentId: 'orchestrator' });
    await runtime.settle();

    const envLeaf = parent.children.find((child) => child.relationship === 'env_leaf');
    const plainLeaf = parent.children.find((child) => child.relationship === 'immediate_leaf');
    assert.ok(envLeaf && plainLeaf, 'both immediate children spawned');

    const envLeafRecord = store.load(envLeaf.reference)!;
    assert.equal(envLeafRecord.env.LEAF_SECRET, SECRET, 'object-form scopedEnv is copied');
    assert.equal(envLeafRecord.env.LEAF_NAME, 'probe-leaf');

    // Sealed on disk: the value reaches the child without being readable in the store.
    const onDisk = readFileSync(path.join(root, 'threads', envLeaf.reference, 'thread.json'), 'utf8');
    assert.ok(!onDisk.includes(SECRET));

    const plainLeafRecord = store.load(plainLeaf.reference)!;
    assert.equal(plainLeafRecord.env.LEAF_SECRET, undefined, 'undeclared env must not leak to a child');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
