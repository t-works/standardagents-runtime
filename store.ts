import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { dirname } from 'node:path';
import type { AttachmentRef, Message, ScheduledEffect, SubagentRegistryEntry, ThreadStatus, ToolAttachment } from '@standardagents/spec';
import { readJson, writeJson, newId, nowUs } from './util.ts';

export interface QueuedMessage {
  kind: 'message';
  id: string;
  side: 'a' | 'b';
  role: 'user' | 'assistant';
  content: string;
  silent: boolean;
  metadata: Record<string, unknown>;
  attachments: Array<AttachmentRef | ToolAttachment>;
  createdAt: number;
}

export interface QueuedTool {
  kind: 'tool';
  id: string;
  side: 'a' | 'b';
  name: string;
  args: Record<string, unknown>;
}

export type QueueEntry = QueuedMessage | QueuedTool;

export interface ThreadRecord {
  id: string;
  agent_id: string;
  user_id: string | null;
  created_at: number;
  terminated: number | null;
  status: ThreadStatus;
  arguments: Record<string, unknown>;
  env: Record<string, string>;
  envTypes: Record<string, 'text' | 'secret'>;
  children: SubagentRegistryEntry[];
  parent_id: string | null;
  /** Side of the parent that owns this child, when this is a subagent thread. */
  owning_side: 'a' | 'b' | null;
  relationship: string | null;
  thread_name: string | null;
  /** True when the thread was created by a blocking relationship. */
  blocking: boolean;
}

export interface CreateThreadInput {
  agentId: string;
  userId?: string | null;
  arguments?: Record<string, unknown>;
  env?: Record<string, string>;
  parentId?: string | null;
  owningSide?: 'a' | 'b' | null;
  relationship?: string | null;
  threadName?: string | null;
  blocking?: boolean;
}

/**
 * File-backed thread store: `.standard-agent/threads/<id>/`.
 * One JSON file per concern keeps writes atomic and the format inspectable.
 */
const ENV_CIPHER = 'aes-256-gcm';
const ENV_PREFIX = 'enc:v1:';

/** 32 bytes as 64 hex chars or base64; anything else fails closed. */
function parseStoreKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('Store key must be 32 bytes: 64 hex chars or base64');
  return key;
}

/**
 * Per-user key location, deliberately outside the store: a copied or leaked store
 * directory alone cannot be decrypted. Not a per-store key, so moving a store to
 * another machine means moving this file too.
 */
export function defaultKeyFile(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'));
  return path.join(base, 'standard-agent', 'store.key');
}

export class ThreadStore {
  readonly root: string;
  private readonly keyFile: string;
  private readonly envKey: Buffer;

  /**
   * Env is encrypted at rest with no operator configuration (Threads §2.3).
   * Hosts holding keys elsewhere (KMS, secret manager, test fixtures) pass
   * `envKey` or `keyFile`; the default per-user key file is then untouched.
   */
  constructor(root: string, options: { envKey?: string; keyFile?: string } = {}) {
    this.root = path.resolve(root);
    this.keyFile = options.keyFile ?? defaultKeyFile();
    mkdirSync(path.join(this.root, 'threads'), { recursive: true });
    this.envKey = options.envKey ? parseStoreKey(options.envKey) : this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    if (existsSync(this.keyFile)) return parseStoreKey(readFileSync(this.keyFile, 'utf8').trim());
    mkdirSync(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(this.keyFile, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  dir(id: string): string {
    return path.join(this.root, 'threads', id);
  }

  filesRoot(id: string): string {
    return path.join(this.dir(id), 'files');
  }

  messagesPath(id: string): string {
    return path.join(this.dir(id), 'messages.json');
  }

  recordPath(id: string): string {
    return path.join(this.dir(id), 'thread.json');
  }

  queuePath(id: string): string {
    return path.join(this.dir(id), 'queue.json');
  }

  effectsPath(id: string): string {
    return path.join(this.dir(id), 'effects.json');
  }

  kvPath(id: string): string {
    return path.join(this.dir(id), 'kv.json');
  }

  create(input: CreateThreadInput): ThreadRecord {
    const record: ThreadRecord = {
      id: newId(),
      agent_id: input.agentId,
      user_id: input.userId ?? null,
      created_at: nowUs(),
      terminated: null,
      status: { state: 'idle', since: 0, reason: null },
      arguments: input.arguments ?? {},
      env: input.env ?? {},
      envTypes: {},
      children: [],
      parent_id: input.parentId ?? null,
      owning_side: input.owningSide ?? null,
      relationship: input.relationship ?? null,
      thread_name: input.threadName ?? null,
      blocking: input.blocking ?? false,
    };
    mkdirSync(this.filesRoot(record.id), { recursive: true });
    this.save(record);
    writeJson(this.messagesPath(record.id), []);
    writeJson(this.kvPath(record.id), {});
    writeJson(this.queuePath(record.id), []);
    writeJson(this.effectsPath(record.id), []);
    return record;
  }

  load(id: string): ThreadRecord | null {
    const record = readJson<ThreadRecord | null>(this.recordPath(id), null);
    return record ? this.openEnv(record) : null;
  }

  /**
   * Settle runs left `running` by a previous process.
   * Runtime policy, not spec-mandated: see ADR stale-run-recovery.
   * Call once at startup, never while an execution in this process is live.
   */
  recoverStale(): number {
    let recovered = 0;
    for (const record of this.list()) {
      if (record.status?.state !== 'running') continue;
      record.status = { state: 'failed', since: nowUs(), reason: 'execution_lost' };
      this.save(record);
      recovered++;
    }
    return recovered;
  }

  save(record: ThreadRecord): void {
    writeJson(this.recordPath(record.id), this.sealEnv(record));
  }

  /**
   * Env is the only secret-bearing field on disk, so it is the only field sealed
   * at rest (Threads §2.3). KV keeps its `MAY` status (Runtime §14.1.9).
   */
  private sealEnv(record: ThreadRecord): ThreadRecord {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(record.env)) env[name] = this.seal(value);
    return { ...record, env };
  }

  private openEnv(record: ThreadRecord): ThreadRecord {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(record.env)) env[name] = this.open(value);
    return { ...record, env };
  }

  private seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ENV_CIPHER, this.envKey, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ENV_PREFIX + [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64')).join('.');
  }

  private open(value: string): string {
    // Plaintext values from a store written before sealing stay readable; the next
    // save seals them.
    if (!value.startsWith(ENV_PREFIX)) return value;
    const parts = value.slice(ENV_PREFIX.length).split('.').map((part) => Buffer.from(part, 'base64'));
    if (parts.length !== 3) throw new Error('Malformed encrypted env value');
    const [iv, tag, body] = parts;
    try {
      const decipher = createDecipheriv(ENV_CIPHER, this.envKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`Thread env is encrypted with another store key (${this.keyFile} missing or replaced)`);
    }
  }

  list(): ThreadRecord[] {
    try {
      return readdirSync(path.join(this.root, 'threads'))
        .map((id) => this.load(id))
        .filter((record): record is ThreadRecord => record !== null)
        .sort((a, b) => a.created_at - b.created_at);
    } catch {
      return [];
    }
  }

  loadMessages(id: string): Message[] {
    return readJson<Message[]>(this.messagesPath(id), []);
  }

  saveMessages(id: string, messages: Message[]): void {
    writeJson(this.messagesPath(id), messages);
  }

  loadQueue(id: string): QueueEntry[] {
    return readJson<QueueEntry[]>(this.queuePath(id), []);
  }

  saveQueue(id: string, queue: QueueEntry[]): void {
    writeJson(this.queuePath(id), queue);
  }

  loadEffects(id: string): ScheduledEffect[] {
    return readJson<ScheduledEffect[]>(this.effectsPath(id), []);
  }

  saveEffects(id: string, effects: ScheduledEffect[]): void {
    writeJson(this.effectsPath(id), effects);
  }

  loadKv(id: string): Record<string, unknown> {
    return readJson<Record<string, unknown>>(this.kvPath(id), {});
  }

  saveKv(id: string, kv: Record<string, unknown>): void {
    writeJson(this.kvPath(id), kv);
  }

  /** Explicit termination destroys the thread and its descendants. */
  destroy(id: string): void {
    const record = this.load(id);
    if (record) for (const child of record.children) this.destroy(child.reference);
    rmSync(this.dir(id), { recursive: true, force: true });
  }
}
