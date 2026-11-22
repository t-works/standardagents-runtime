import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AttachmentRef } from '@standardagents/spec';
import type { RuntimeLike } from './contract.ts';
import { ThreadStore } from './store.ts';
import { Thread } from './thread.ts';

/** §8.1 only needs the store, the files and a log line; nothing here runs a turn. */
function pair() {
  const base = mkdtempSync(path.join(tmpdir(), 'sa-attach-'));
  const store = new ThreadStore(path.join(base, 'data'), { keyFile: path.join(base, 'store.key') });
  const warnings: string[] = [];
  const runtime = { store, log: (_level: string, message: string) => warnings.push(message) } as unknown as RuntimeLike;
  const parent = new Thread(runtime, store.create({ agentId: 'parent' }));
  const child = new Thread(runtime, store.create({ agentId: 'child', parentId: parent.threadId }));
  parent.files.writeFile('shared.txt', 'from the parent');
  return { parent, child, warnings, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ref = (file: string): AttachmentRef => ({ id: file, type: 'file', path: file, name: file, mimeType: 'text/plain', size: 0 });

test('a referenced parent path is copied into the child and rewritten to a child-local path', () => {
  const { parent, child, cleanup } = pair();
  try {
    const refs = child.copyAttachmentsFrom(parent, ['shared.txt', ref('shared.txt')]);
    assert.deepEqual(refs.map((entry) => (entry as AttachmentRef).path), ['/shared.txt', '/shared.txt']);
    assert.equal(readFileSync(path.join(child.files.root, 'shared.txt'), 'utf8'), 'from the parent');
  } finally {
    cleanup();
  }
});

test('inline data is left for the child to write, and a missing parent file is dropped with a warning', () => {
  const { parent, child, warnings, cleanup } = pair();
  try {
    const inline = { data: Buffer.from('inline').toString('base64'), name: 'note.txt', mimeType: 'text/plain' };
    const refs = child.copyAttachmentsFrom(parent, [inline, 'missing.txt']);
    assert.equal(refs.length, 1);
    assert.equal(refs[0], inline, 'the child materializes its own copy, so the bytes pass through untouched');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing\.txt/);
  } finally {
    cleanup();
  }
});
