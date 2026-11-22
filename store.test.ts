import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultKeyFile, ThreadStore } from './store.ts';

const SECRET = 'test-secret-1234567890';

/** Every store in these tests gets a temp key file, so the real user config is never written. */
function fresh() {
  const base = mkdtempSync(path.join(tmpdir(), 'sa-store-'));
  const root = path.join(base, 'data');
  const keyFile = path.join(base, 'config', 'store.key');
  return { root, keyFile, store: (options = {}) => new ThreadStore(root, { keyFile, ...options }), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('seals env at rest with no configuration, and reads it back after a restart', () => {
  const { root, keyFile, store, cleanup } = fresh();
  try {
    const created = store().create({ agentId: 'leaf', env: { OPENAI_API_KEY: SECRET } });
    assert.equal(created.env.OPENAI_API_KEY, SECRET, 'create() returns plaintext');

    const onDisk = readFileSync(path.join(root, 'threads', created.id, 'thread.json'), 'utf8');
    assert.ok(!onDisk.includes(SECRET), 'secret must not appear on disk');
    assert.ok(onDisk.includes('enc:v1:'), 'env values carry the cipher marker');
    assert.ok(existsSync(keyFile), 'key file is created on first use');
    assert.ok(!existsSync(path.join(root, 'store.key')), 'the key never lives inside the store');

    assert.equal(store().load(created.id)?.env.OPENAI_API_KEY, SECRET);
  } finally {
    cleanup();
  }
});

test('the default key file is outside the store, under the per-user config directory', () => {
  const file = defaultKeyFile();
  assert.ok(file.endsWith(path.join('standard-agent', 'store.key')));
  assert.equal(path.dirname(path.dirname(file)).length > 1, true);
});

test('the key file is reused, and stays owner-only where the platform honours modes', () => {
  const { keyFile, store, cleanup } = fresh();
  try {
    store();
    const first = readFileSync(keyFile, 'utf8');
    store();
    assert.equal(readFileSync(keyFile, 'utf8'), first, 'second open must not rotate the key');
    if (process.platform !== 'win32') {
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(keyFile)).mode & 0o777 & 0o077, 0, 'config dir is not group/world accessible');
    }
  } finally {
    cleanup();
  }
});

test('later saves stay sealed across inheritance and propagation', () => {
  const { root, store, cleanup } = fresh();
  try {
    const parent = store().create({ agentId: 'orchestrator', env: { TOKEN: SECRET } });
    const child = store().create({ agentId: 'leaf', env: { TOKEN: SECRET }, parentId: parent.id });
    child.env.TOKEN = 'rotated-secret';
    store().save(child);

    assert.ok(!readFileSync(path.join(root, 'threads', child.id, 'thread.json'), 'utf8').includes('rotated-secret'));
    assert.equal(store().load(child.id)?.env.TOKEN, 'rotated-secret');
  } finally {
    cleanup();
  }
});

test('a legacy plaintext store stays readable and is sealed on the next save', () => {
  const { root, store, cleanup } = fresh();
  try {
    const created = store().create({ agentId: 'leaf', env: { TOKEN: SECRET } });
    const file = path.join(root, 'threads', created.id, 'thread.json');
    // Simulate a store written before env sealing existed.
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    legacy.env.TOKEN = SECRET;
    writeFileSync(file, JSON.stringify(legacy));

    assert.equal(store().load(created.id)?.env.TOKEN, SECRET);
    store().save(store().load(created.id)!);
    assert.ok(!readFileSync(file, 'utf8').includes(SECRET));
  } finally {
    cleanup();
  }
});

test('a host-supplied key is used instead of the key file, and mismatches fail closed', () => {
  const { root, keyFile, store, cleanup } = fresh();
  try {
    const created = new ThreadStore(root, { envKey: 'a'.repeat(64) }).create({
      agentId: 'leaf',
      env: { TOKEN: SECRET },
    });
    assert.ok(!existsSync(keyFile), 'no key file when the host supplies one');

    assert.equal(store({ envKey: 'a'.repeat(64) }).load(created.id)?.env.TOKEN, SECRET);
    assert.throws(() => store({ envKey: 'b'.repeat(64) }).load(created.id), /another store key/);
    assert.throws(() => store({ envKey: 'too-short' }), /32 bytes/);
  } finally {
    cleanup();
  }
});
