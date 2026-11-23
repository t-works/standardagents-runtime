import type {
  AgentDefinition,
  AttachmentRef,
  CodeExecution,
  CodeExecutionOptions,
  DecideOptions,
  DecisionQuestions,
  DecisionResult,
  FileChunk,
  FileRecord,
  FileStats,
  FindResult,
  GetMessagesOptions,
  GrepResult,
  HookExecutionContext,
  ListUserValuesOptions,
  Message,
  MessagesResult,
  PromptDefinition,
  ReaddirResult,
  ScheduledEffect,
  SkillsNamespace,
  SubagentRegistryEntry,
  ThreadState,
  ThreadStatus,
  ToolAttachment,
  ToolResult,
  UserHandle,
  UserValueEntry,
  WriteFileOptions,
} from '@standardagents/spec';
import { ThreadFiles } from './files.ts';
import { run } from './sandbox.ts';
import { unqualify, type AnyHook } from './loader.ts';
import type { RuntimeLike, SessionStopOptions } from './contract.ts';
import type { QueueEntry, ThreadRecord } from './store.ts';
import { errorMessage, newId, nowUs, parseJson, redactEnvValues } from './util.ts';
import { resolveHooks } from './hooks.ts';

export interface NewMessage {
  role: Message['role'];
  content: string | null;
  name?: string | null;
  tool_calls?: string | null;
  tool_call_id?: string | null;
  tool_status?: 'success' | 'error' | null;
  silent?: boolean;
  metadata?: Record<string, unknown>;
  attachments?: AttachmentRef[] | null;
  reasoning_content?: string | null;
  reasoning_details?: string | null;
  prompt?: string | null;
  parent_id?: string | null;
  depth?: number;
}

export interface InjectInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface QueueMessageInput {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<ToolAttachment | AttachmentRef>;
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

/** `user` is the side B perspective, `assistant` the side A perspective. */
export function triggerSideFor(role: Message['role']): 'a' | 'b' {
  return role === 'assistant' ? 'b' : 'a';
}

/**
 * A live thread: identity, persisted messages, file system, queue, effects and
 * the `ThreadState` handed to definitions. One execution at a time.
 */
export class Thread implements ThreadState {
  readonly data: ThreadRecord;
  readonly store: RuntimeLike['store'];
  readonly files: ThreadFiles;
  readonly runtime: RuntimeLike;
  messages: Message[];
  context: Record<string, unknown> = {};
  execution: ThreadState['execution'] = null;
  /** Prompt and side of the turn currently executing (env precedence, hooks). */
  activePrompt: string | null = null;
  activeSide: 'a' | 'b' | null = null;
  activeEnvDefaults: Record<string, string> = {};
  /** Session result of the last ended session (used by blocking parents). */
  lastSessionResult: string | null = null;

  constructor(runtime: RuntimeLike, data: ThreadRecord) {
    this.runtime = runtime;
    this.data = data;
    this.store = runtime.store;
    this.files = new ThreadFiles(runtime.store.filesRoot(data.id));
    this.messages = runtime.store.loadMessages(data.id);
  }

  // ── identity ────────────────────────────────────────────────────────────
  get threadId(): string {
    return this.data.id;
  }
  get agentId(): string {
    return this.data.agent_id;
  }
  get userId(): string | null {
    return this.data.user_id;
  }
  get createdAt(): number {
    return this.data.created_at;
  }
  get children(): SubagentRegistryEntry[] {
    return this.data.children;
  }
  get terminated(): number | null {
    return this.data.terminated;
  }
  get arguments(): Record<string, unknown> {
    return this.data.arguments;
  }
  get busy(): boolean {
    return this.execution !== null;
  }

  get agent(): AgentDefinition {
    const agent = this.runtime.registry.agents.get(this.data.agent_id);
    if (!agent) throw new Error(`Unknown agent '${this.data.agent_id}' for thread ${this.data.id}`);
    return agent;
  }

  get prompt(): PromptDefinition | null {
    if (!this.activePrompt) return null;
    return this.runtime.registry.prompts.get(this.activePrompt) ?? null;
  }

  save(): void {
    this.store.save(this.data);
  }

  setStatusRecord(status: ThreadStatus): void {
    this.data.status = status;
    this.save();
    this.runtime.notify({ type: 'status', threadId: this.data.id, status });
  }

  // ── messages ────────────────────────────────────────────────────────────
  async getMessages(options: GetMessagesOptions = {}): Promise<MessagesResult> {
    const includeSilent = options.includeSilent ?? false;
    let rows = this.messages.filter((message) => includeSilent || !message.silent);
    if (options.maxDepth !== undefined) rows = rows.filter((message) => (message.depth ?? 0) <= options.maxDepth!);
    const total = rows.length;
    if (options.order !== 'asc') rows = [...rows].reverse();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? total;
    const page = rows.slice(offset, offset + limit);
    return { messages: page, total, hasMore: offset + page.length < total };
  }

  async getMessage(messageId: string): Promise<Message | null> {
    return this.messages.find((message) => message.id === messageId) ?? null;
  }

  /** All messages, oldest first, for context assembly and transcripts. */
  allMessages(): Message[] {
    return this.messages;
  }

  async injectMessage(input: InjectInput): Promise<Message> {
    const message = await this.persist({
      role: input.role,
      content: input.content,
      silent: input.silent ?? false,
      metadata: input.metadata ?? {},
      prompt: this.activePrompt,
    });
    if (!this.busy) void this.runtime.start(this, triggerSideFor(input.role));
    return message;
  }

  async queueMessage(input: QueueMessageInput, options: { trigger?: boolean } = {}): Promise<void> {
    if (this.data.terminated) throw new Error(`Thread ${this.data.id} is terminated`);
    const entry: QueueEntry = {
      kind: 'message',
      id: newId(),
      side: triggerSideFor(input.role),
      role: input.role,
      content: input.content,
      silent: input.silent ?? false,
      metadata: input.metadata ?? {},
      attachments: input.attachments ?? [],
      createdAt: nowUs(),
    };
    const queue = this.store.loadQueue(this.data.id);
    queue.push(entry);
    this.store.saveQueue(this.data.id, queue);
    if (options.trigger !== false) void this.runtime.start(this, entry.side);
  }

  async updateMessage(messageId: string, updates: Record<string, unknown>): Promise<Message> {
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error(`No message ${messageId}`);
    let data: Record<string, unknown> = { ...updates };
    for (const hook of this.threadHooks('before_update_message')) {
      try {
        data = await hook.execute(this, messageId, data, this.hookContext(hook));
      } catch (error) {
        this.runtime.log('warn', `before_update_message '${hook.id}' failed: ${errorMessage(error)}`, this.data.id);
      }
    }
    const next: Message = {
      ...this.messages[index],
      ...(data as Partial<Message>),
      metadata: { ...(this.messages[index].metadata ?? {}), ...((data.metadata as Record<string, unknown>) ?? {}) },
    };
    this.messages[index] = next;
    this.store.saveMessages(this.data.id, this.messages);
    this.runtime.notify({ type: 'message_updated', threadId: this.data.id, message: next });
    for (const hook of this.threadHooks('after_update_message')) {
      try {
        await hook.execute(this, next, this.hookContext(hook));
      } catch (error) {
        this.runtime.log('warn', `after_update_message '${hook.id}' failed: ${errorMessage(error)}`, this.data.id);
      }
    }
    return next;
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const target = this.messages.find((message) => message.id === messageId);
    if (!target) return false;
    const toolCallIds = new Set(
      parseJson<Array<{ id: string }>>(target.tool_calls, []).map((call) => call.id),
    );
    this.messages = this.messages.filter(
      (message) => message.id !== messageId && !(message.role === 'tool' && message.tool_call_id && toolCallIds.has(message.tool_call_id)),
    );
    this.store.saveMessages(this.data.id, this.messages);
    return true;
  }

  /** Persist a message through the lifecycle hooks. Internal to the runtime. */
  async persist(input: NewMessage): Promise<Message> {
    let message: Message = {
      id: newId(),
      role: input.role,
      content: input.content,
      name: input.name ?? null,
      tool_calls: input.tool_calls ?? null,
      tool_call_id: input.tool_call_id ?? null,
      tool_status: input.tool_status ?? null,
      created_at: nowUs(),
      parent_id: input.parent_id ?? null,
      depth: input.depth ?? 0,
      silent: input.silent ?? false,
      metadata: input.metadata ?? {},
      status: 'completed',
      attachments: input.attachments ?? null,
      reasoning_content: input.reasoning_content ?? null,
      reasoning_details: input.reasoning_details ?? null,
      prompt: input.prompt ?? this.activePrompt ?? null,
    };
    for (const hook of this.threadHooks('before_create_message')) {
      try {
        message = await hook.execute(this, message, this.hookContext(hook));
      } catch (error) {
        throw new Error(`before_create_message '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }
    this.messages.push(message);
    this.store.saveMessages(this.data.id, this.messages);
    this.runtime.notify({ type: 'message', threadId: this.data.id, message });
    for (const hook of this.threadHooks('after_create_message')) {
      try {
        await hook.execute(this, message, this.hookContext(hook));
      } catch (error) {
        this.runtime.log('warn', `after_create_message '${hook.id}' failed: ${errorMessage(error)}`, this.data.id);
      }
    }
    return message;
  }

  // ── resources ───────────────────────────────────────────────────────────
  async loadModel<T = unknown>(name: string): Promise<T> {
    const model = this.runtime.registry.models.get(unqualify(name));
    if (!model) throw new Error(`Unknown model '${name}'`);
    return model as T;
  }
  async loadPrompt<T = unknown>(name: string): Promise<T> {
    const prompt = this.runtime.registry.prompts.get(unqualify(name));
    if (!prompt) throw new Error(`Unknown prompt '${name}'`);
    return prompt as T;
  }
  async loadAgent<T = unknown>(name: string): Promise<T> {
    const agent = this.runtime.registry.agents.get(unqualify(name));
    if (!agent) throw new Error(`Unknown agent '${name}'`);
    return agent as T;
  }
  getPromptNames(): string[] {
    return [...this.runtime.registry.prompts.keys()];
  }
  getAgentNames(): string[] {
    return [...this.runtime.registry.agents.keys()];
  }
  getModelNames(): string[] {
    return [...this.runtime.registry.models.keys()];
  }

  async getChildThread(referenceId: string): Promise<Thread | null> {
    const entry = this.data.children.find((child) => child.reference === referenceId);
    if (!entry) return null;
    const record = this.store.load(entry.reference);
    return record ? this.runtime.threadFor(record) : null;
  }

  async getParentThread(): Promise<Thread | null> {
    if (!this.data.parent_id) return null;
    const record = this.store.load(this.data.parent_id);
    return record ? this.runtime.threadFor(record) : null;
  }

  // ── environment ─────────────────────────────────────────────────────────
  async env(propertyName: string): Promise<string> {
    const value = await this.resolveEnv(propertyName);
    if (value === undefined) throw new Error(`Missing environment variable '${propertyName}'`);
    return value;
  }

  async instanceEnv(propertyName: string): Promise<string | undefined> {
    return this.runtime.instanceEnv(propertyName);
  }

  async envType(propertyName: string): Promise<'text' | 'secret'> {
    return this.data.envTypes[propertyName] ?? 'secret';
  }

  /** Mask every secret env value in `text` before it reaches a model, client or log. */
  redact(text: string): string {
    return redactEnvValues(this.data.env, this.data.envTypes, text);
  }

  async setEnv(propertyName: string, value: string, options: { type?: 'text' | 'secret' } = {}): Promise<void> {
    this.data.env[propertyName] = value;
    this.data.envTypes[propertyName] = options.type ?? this.data.envTypes[propertyName] ?? 'secret';
    this.save();
    this.propagateEnv(propertyName, value, new Set([this.data.id]));
  }

  private async resolveEnv(name: string): Promise<string | undefined> {
    if (this.data.env[name] !== undefined) return this.data.env[name];
    const agent = this.runtime.registry.agents.get(this.data.agent_id);
    if (agent?.env?.[name] !== undefined) return agent.env[name];
    if (this.activeEnvDefaults[name] !== undefined) return this.activeEnvDefaults[name];
    if (this.prompt?.env?.[name] !== undefined) return this.prompt.env[name];
    return this.runtime.instanceEnv(name);
  }

  private propagateEnv(name: string, value: string, seen: Set<string>): void {
    for (const child of this.data.children) {
      if (seen.has(child.reference)) continue;
      seen.add(child.reference);
      const record = this.store.load(child.reference);
      if (!record || record.terminated) continue;
      if (this.isScopedFor(record.agent_id, name)) continue;
      record.env[name] = value;
      record.envTypes[name] = record.envTypes[name] ?? 'secret';
      this.store.save(record);
      this.runtime.threadFor(record).propagateEnv(name, value, seen);
    }
  }

  private isScopedFor(agentId: string, name: string): boolean {
    const agent = this.runtime.registry.agents.get(agentId);
    if (!agent) return false;
    for (const side of [agent.sideA, agent.sideB]) {
      if (!side?.prompt) continue;
      const prompt = this.runtime.registry.prompts.get(unqualify(side.prompt));
      if (prompt?.variables?.some((variable) => variable.name === name && variable.scoped)) return true;
    }
    return false;
  }

  // ── hierarchy ───────────────────────────────────────────────────────────
  /** Role that prompts the relationship's owning side (Subagents §2.1). */
  get parentInboundRole(): 'user' | 'assistant' {
    return this.data.owning_side === 'b' ? 'assistant' : 'user';
  }

  async notifyParent(content: string): Promise<void> {
    const parent = await this.getParentThread();
    if (!parent) return;
    await parent.queueMessage({
      role: this.parentInboundRole,
      content,
      silent: true,
      metadata: { subagent_id: this.data.id, forwarded_from: this.data.id },
    });
  }

  async setStatus(status: string): Promise<void> {
    const parent = await this.getParentThread();
    if (!parent) return;
    const entry = parent.data.children.find((child) => child.reference === this.data.id);
    if (!entry) return;
    entry.status = status;
    parent.save();
    this.runtime.notify({
      type: 'subagent',
      threadId: parent.data.id,
      reference: entry.reference,
      relationship: entry.relationship,
      name: entry.name,
      status,
    });
  }

  async stopSession(options: SessionStopOptions = {}): Promise<void> {
    this.lastSessionResult = options.result ?? this.lastSessionResult;
    if (options.notifyParent) await this.notifyParent(options.notifyParent);
    if (options.status) await this.setStatus(options.status);
    this.runtime.requestSessionStop(this, options);
  }

  // ── tools, effects, events ──────────────────────────────────────────────
  queueTool(toolName: string, args: Record<string, unknown>): void {
    this.runtime.queueTool(this, toolName, args);
  }

  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.runtime.invokeTool(this, toolName, args);
  }

  async scheduleEffect(name: string, args: Record<string, unknown>, delay = 0): Promise<string> {
    const now = nowUs();
    const effect: ScheduledEffect = {
      id: newId(),
      name: unqualify(name),
      args,
      scheduledAt: now + Math.max(0, delay) * 1000,
      createdAt: now,
    };
    const effects = this.store.loadEffects(this.data.id);
    effects.push(effect);
    this.store.saveEffects(this.data.id, effects);
    this.runtime.scheduleEffect(this, effect.id);
    return effect.id;
  }

  async getScheduledEffects(name?: string): Promise<ScheduledEffect[]> {
    const effects = this.store.loadEffects(this.data.id);
    return name ? effects.filter((effect) => effect.name === unqualify(name)) : effects;
  }

  async removeScheduledEffect(id: string): Promise<boolean> {
    const effects = this.store.loadEffects(this.data.id);
    const next = effects.filter((effect) => effect.id !== id);
    if (next.length === effects.length) return false;
    this.store.saveEffects(this.data.id, next);
    return true;
  }

  emit(event: string, data: unknown): void {
    this.runtime.emit(this, event, data);
  }

  // ── durable key-value store ─────────────────────────────────────────────
  async getValue<T = unknown>(key: string): Promise<T | null> {
    const kv = this.store.loadKv(this.data.id);
    return (kv[key] as T | undefined) ?? null;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const kv = this.store.loadKv(this.data.id);
    if (value === null || value === undefined) delete kv[key];
    else kv[key] = JSON.parse(JSON.stringify(value));
    this.store.saveKv(this.data.id, kv);
  }

  async status(): Promise<ThreadStatus> {
    return this.data.status;
  }

  async decide<const Q extends DecisionQuestions>(options: DecideOptions<Q>): Promise<DecisionResult<Q>> {
    const provider = await this.runtime.decisionProvider(this, options.provider);
    return provider.decide({
      model: options.model,
      context: options.context,
      questions: options.questions,
      signal: options.signal,
    });
  }

  async user(): Promise<UserHandle | null> {
    // shortcut: no user directory behind the runner, so only the id is known; upgrade when an agent needs identity fields.
    return this.data.user_id ? ({ id: this.data.user_id } as unknown as UserHandle) : null;
  }

  // Unimplemented ThreadState surface. Throwing beats a silent no-op: packaged code that
  // relies on these fails loudly instead of pretending the work happened.
  async runAgent(_agentName: string): Promise<void> {
    throw new Error('state.runAgent is not implemented by this runtime');
  }

  async getUserValue<T = unknown>(_key: string): Promise<T | null> {
    throw new Error('state.getUserValue is not implemented by this runtime');
  }

  async setUserValue(_key: string, _value: unknown): Promise<void> {
    throw new Error('state.setUserValue is not implemented by this runtime');
  }

  async listUserValues(_options?: ListUserValuesOptions): Promise<{ entries: UserValueEntry[]; total: number }> {
    throw new Error('state.listUserValues is not implemented by this runtime');
  }

  get skills(): SkillsNamespace {
    throw new Error('state.skills is not implemented by this runtime');
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<FileRecord> {
    return this.files.moveFile(sourcePath, destinationPath);
  }

  async renameFile(path: string, newName: string): Promise<FileRecord> {
    return this.files.renameFile(path, newName);
  }

  runCode(source: string, options?: CodeExecutionOptions): CodeExecution {
    const handle = run(source, options);
    // §14.9: an abort during this execution stops the sandbox at its next yield point.
    const signal = this.execution?.abortSignal;
    if (signal) {
      const terminate = (): void => handle.terminate('Thread terminated');
      if (signal.aborted) terminate();
      else {
        signal.addEventListener('abort', terminate, { once: true });
        // The listener outlives the handle otherwise, and a settled run has nothing left to stop.
        const done = (): void => signal.removeEventListener('abort', terminate);
        void handle.then(done, done);
      }
    }
    return handle;
  }

  // ── file system ─────────────────────────────────────────────────────────
  async writeFile(path: string, data: ArrayBuffer | string, mimeType: string, options?: WriteFileOptions): Promise<FileRecord> {
    return this.files.writeFile(path, data, mimeType, options);
  }
  async readFile(path: string): Promise<ArrayBuffer | null> {
    return this.files.readFile(path);
  }
  async readFileStream(path: string, options?: { signal?: AbortSignal }): Promise<AsyncIterable<FileChunk> | null> {
    if (!this.files.statFile(path)) return null;
    return this.files.readFileStream(path, options);
  }
  async statFile(path: string): Promise<FileRecord | null> {
    return this.files.statFile(path);
  }
  async readdirFile(path: string): Promise<ReaddirResult> {
    return this.files.readdirFile(path);
  }
  async unlinkFile(path: string): Promise<void> {
    this.files.unlinkFile(path);
  }
  async mkdirFile(path: string): Promise<FileRecord> {
    return this.files.mkdirFile(path);
  }
  async rmdirFile(path: string): Promise<void> {
    this.files.rmdirFile(path);
  }
  async getFileStats(): Promise<FileStats> {
    return this.files.getFileStats();
  }
  async grepFiles(pattern: string): Promise<GrepResult[]> {
    return this.files.grepFiles(pattern);
  }
  async findFiles(pattern: string): Promise<FindResult> {
    return this.files.findFiles(pattern);
  }
  async getFileThumbnail(path: string): Promise<ArrayBuffer | null> {
    return this.files.getFileThumbnail(path);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  async terminate(): Promise<void> {
    const stamp = nowUs();
    this.data.terminated = stamp;
    this.data.status = { state: 'idle', since: stamp, reason: 'terminated' };
    this.save();
    this.runtime.requestTerminate(this);
    for (const child of this.data.children) {
      const record = this.store.load(child.reference);
      if (!record) continue;
      await this.runtime.threadFor(record).terminate();
      child.status = 'terminated';
    }
    this.save();
    const parent = await this.getParentThread();
    if (parent) {
      const entry = parent.data.children.find((child) => child.reference === this.data.id);
      if (entry) entry.status = 'terminated';
      parent.save();
    }
  }

  /** Materialize queued attachments into this thread's file system. */
  async materializeAttachments(attachments: Array<ToolAttachment | AttachmentRef>): Promise<AttachmentRef[]> {
    const out: AttachmentRef[] = [];
    for (const attachment of attachments) {
      if ('data' in attachment) {
        const name = attachment.name || 'attachment';
        const record = this.files.writeFile(
          `/attachments/${newId()}-${name}`,
          new Uint8Array(Buffer.from(attachment.data, 'base64')).buffer,
          attachment.mimeType,
          { width: attachment.width, height: attachment.height },
        );
        out.push({ id: record.path, type: 'file', path: record.path, name: record.name, mimeType: record.mimeType, size: record.size });
      } else if (attachment?.path) {
        out.push(attachment);
      }
    }
    return out;
  }

  /**
   * §8.1: a referenced attachment is copied into this thread and the queued message
   * names the local path, because the source thread's path is not valid here.
   */
  copyAttachmentsFrom(parent: Thread, attachments: Array<ToolAttachment | AttachmentRef | string>): Array<ToolAttachment | AttachmentRef> {
    const out: Array<ToolAttachment | AttachmentRef> = [];
    for (const attachment of attachments) {
      // Inline data has no path to rewrite; materializeAttachments writes the bytes on this side.
      if (typeof attachment !== 'string' && 'data' in attachment) {
        out.push(attachment);
        continue;
      }
      const source = typeof attachment === 'string' ? attachment : attachment?.path;
      if (!source) continue;
      try {
        const record = this.files.importFrom(parent.files.root, source);
        out.push({ id: record.path, type: 'file', path: record.path, name: record.name, mimeType: record.mimeType, size: record.size });
      } catch (error) {
        this.runtime.log('warn', `Could not copy attachment '${source}' to the child: ${errorMessage(error)}`, this.data.id);
      }
    }
    return out;
  }

  // ── hooks ───────────────────────────────────────────────────────────────
  threadHooks(name: string): AnyHook[] {
    return this.runtimeHooks(name).map((entry) => entry.hook);
  }

  runtimeHooks(name: string): Array<{ hook: AnyHook; context: HookExecutionContext }> {
    return resolveHooks(this.runtime.registry, this.agent, this.activePrompt, name, (flag) =>
      this.data.env[flag] ?? this.agent.env?.[flag] ?? this.runtime.instanceEnv(flag),
    );
  }

  hookContext(hook: AnyHook): HookExecutionContext {
    const found = this.runtimeHooks(hook.hook).find((entry) => entry.hook.id === hook.id);
    return found?.context ?? { source: { kind: 'agent', agentName: this.data.agent_id } };
  }

  /** Drain the durable queue: materialize messages, execute queued tools. */
  async drainQueue(): Promise<QueueEntry[]> {
    const queue = this.store.loadQueue(this.data.id);
    if (!queue.length) return [];
    this.store.saveQueue(this.data.id, []);
    for (const entry of queue) {
      if (entry.kind === 'message') {
        const attachments = await this.materializeAttachments(entry.attachments ?? []);
        await this.persist({
          role: entry.role,
          content: entry.content,
          silent: entry.silent,
          metadata: { ...entry.metadata, queued: undefined },
          attachments: attachments.length ? attachments : null,
        });
      }
    }
    return queue.filter((entry) => entry.kind === 'tool');
  }

  exportSessionResult(): string | null {
    return this.lastSessionResult;
  }
}
