import { ProviderError } from '@standardagents/spec';
import type {
  AgentDefinition,
  AttachmentRef,
  DecisionProviderFactory,
  DecisionProviderInterface,
  HookExecutionContext,
  HookMessage,
  HookToolCall,
  HookToolResult,
  LLMMessage,
  Message,
  ModelDefinition,
  PromptDefinition,
  PromptSide,
  ProviderConfigSlots,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderTool,
  SideConfig,
  SubagentRelationship,
  ThreadState,
  ToolDefinition,
  ToolAttachment,
  ToolResult,
} from '@standardagents/spec';
import { z } from 'zod';
import type { RuntimeEvent, RuntimeLike, SessionStopOptions } from './contract.ts';
import { resolveHooks, relationshipEnabled } from './hooks.ts';
import type { AnyHook, Registry } from './loader.ts';
import { unqualify } from './loader.ts';
import type { CreateThreadInput, QueueEntry, ThreadRecord } from './store.ts';
import { ThreadStore } from './store.ts';
import { Thread } from './thread.ts';
import { asText, errorMessage, newId, nowUs, parseJson } from './util.ts';

/** §7.4: an attachments property holds one attachment or a list of them. */
const asAttachmentList = (value: unknown): Array<ToolAttachment | AttachmentRef | string> =>
  (Array.isArray(value) ? value : value == null ? [] : [value]).filter(
    (entry): entry is ToolAttachment | AttachmentRef | string =>
      typeof entry === 'string' || (!!entry && typeof entry === 'object' && ('path' in entry || 'data' in entry)),
  );

export interface RuntimeOptions {
  store: ThreadStore;
  registry: Registry;
  onEvent?: (event: RuntimeEvent) => void;
  instanceEnv?: (name: string) => string | undefined;
  /** Per-turn step cap when a side declares no `maxSteps`. */
  maxSteps?: number;
  /** Hard execution step cap across both sides. */
  maxTotalSteps?: number;
  /** Retries for retryable provider errors, per model. */
  providerRetries?: number;
}

interface ToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  kind: 'function' | 'prompt' | 'agent' | 'lifecycle';
  definition?: ToolDefinition;
  promptName?: string;
  agentName?: string;
  config?: Record<string, unknown>;
  relationship?: SubagentRelationship;
  lifecycle?: 'subagents' | 'subagent_create' | 'subagent_message';
}

const LIFECYCLE_TOOLS = new Set(['subagents', 'subagent_create', 'subagent_message']);

function sideOfMessage(message: Message | HookMessage): 'a' | 'b' {
  const recorded = (message as Message).metadata?.side;
  if (recorded === 'a' || recorded === 'b') return recorded;
  return message.role === 'assistant' ? 'a' : 'b';
}

function toolCallJson(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): string {
  return JSON.stringify(
    calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
  );
}

function parseToolCalls(raw: string | null | undefined): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return parseJson<Array<{ id: string; function?: { name?: string; arguments?: string } }>>(raw, []).map((call) => ({
    id: call.id,
    name: call.function?.name ?? '',
    arguments: parseJson<Record<string, unknown>>(call.function?.arguments, {}),
  }));
}

function jsonSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  try {
    return z.toJSONSchema(schema as never, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function validateArgs(schema: unknown, args: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') return { ok: true, value: args };
  const parsed = (schema as { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }).safeParse(args);
  if (parsed.success) return { ok: true, value: (parsed.data ?? args) as Record<string, unknown> };
  const detail = (parsed.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; ');
  return { ok: false, error: `Invalid arguments: ${detail}` };
}

function normalizeToolResult(value: unknown): ToolResult {
  if (typeof value === 'string') return { status: 'success', result: value };
  if (value && typeof value === 'object' && 'status' in (value as Record<string, unknown>)) return value as ToolResult;
  if (value == null) return { status: 'success', result: '' };
  return { status: 'success', result: asText(value) };
}

/**
 * Executes Standard Agents on threads: one step at a time, persisting messages
 * and tool results before advancing, enforcing stop semantics, and coordinating
 * parent/child threads.
 */
export class Runtime implements RuntimeLike {
  readonly store: ThreadStore;
  readonly registry: Registry;
  readonly onEvent?: (event: RuntimeEvent) => void;
  readonly maxSteps: number;
  readonly maxTotalSteps: number;
  readonly providerRetries: number;
  private readonly envLookup: (name: string) => string | undefined;
  private readonly executions = new Map<string, Execution>();
  private readonly threads = new Map<string, Thread>();
  private readonly runs = new Set<Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly providers = new Map<string, ReturnType<ModelDefinition['provider']>>();
  private readonly toolCallStack: Array<{ uses?: readonly string[] }> = [];

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.onEvent = options.onEvent;
    this.maxSteps = options.maxSteps ?? 12;
    this.maxTotalSteps = options.maxTotalSteps ?? 200;
    this.providerRetries = options.providerRetries ?? 2;
    this.envLookup = options.instanceEnv ?? ((name) => process.env[name]);
  }

  // ── RuntimeLike ─────────────────────────────────────────────────────────
  instanceEnv(name: string): string | undefined {
    return this.envLookup(name);
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.onEvent?.({ type: 'log', level, message });
  }

  emit(thread: Thread, event: string, data: unknown): void {
    let redacted = data;
    try {
      redacted = JSON.parse(thread.redact(JSON.stringify(data)));
    } catch {
      // Non-JSON payloads pass through; env values only arrive as text.
    }
    this.onEvent?.({ type: 'event', event, data: redacted });
  }

  notify(event: RuntimeEvent): void {
    this.onEvent?.(event);
  }

  threadFor(record: ThreadRecord): Thread {
    const existing = this.threads.get(record.id);
    if (existing) return existing;
    const thread = new Thread(this, record);
    this.threads.set(record.id, thread);
    return thread;
  }

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const record = this.store.create(input);
    const thread = this.threadFor(record);
    await this.spawnImmediate(thread);
    for (const { hook, context } of thread.runtimeHooks('after_thread_created')) {
      try {
        await hook.execute(thread, context);
      } catch (error) {
        this.log('warn', `after_thread_created '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }
    return thread;
  }

  start(thread: Thread, triggerSide: 'a' | 'b' = 'a'): Promise<void> {
    if (thread.data.terminated) return Promise.reject(new Error(`Thread ${thread.threadId} is terminated`));
    const running = this.executions.get(thread.threadId);
    if (running) return running.done;
    const execution = new Execution(this, thread, triggerSide);
    this.executions.set(thread.threadId, execution);
    thread.execution = execution.state;
    if (thread.data.parent_id) {
      const parentRecord = this.store.load(thread.data.parent_id);
      const parent = parentRecord ? this.threadFor(parentRecord) : null;
      const entry = parent?.data.children.find((child) => child.reference === thread.threadId);
      if (parent && entry) {
        entry.status = 'running';
        parent.save();
        this.notify({ type: 'subagent', reference: entry.reference, relationship: entry.relationship, name: entry.name, status: 'running' });
      }
    }
    const done = execution.run().finally(() => {
      this.executions.delete(thread.threadId);
      thread.execution = null;
      // Work queued after the final drain still gets a turn (durable queue, Runtime §9).
      const queued = this.store.loadQueue(thread.threadId);
      if (queued.length && !thread.data.terminated) {
        void this.start(thread, queued[0].side);
      }
    });
    execution.done = done;
    this.runs.add(done);
    void done.finally(() => this.runs.delete(done));
    return done;
  }

  async settle(): Promise<void> {
    while (this.runs.size) {
      await Promise.allSettled([...this.runs]);
    }
  }

  isBusy(threadId: string): boolean {
    return this.executions.has(threadId);
  }

  requestSessionStop(thread: Thread, options: SessionStopOptions): void {
    const execution = this.executions.get(thread.threadId);
    if (execution) execution.requestStop(options);
    else thread.lastSessionResult = options.result ?? thread.lastSessionResult;
  }

  requestTerminate(thread: Thread): void {
    this.executions.get(thread.threadId)?.abort.abort(new Error('Thread terminated'));
  }

  // ── model calls ─────────────────────────────────────────────────────────
  /** Factory config from declared slots: thread env first, then the declared default. */
  private async providerConfig(
    thread: Thread,
    label: string,
    factory: { configSlots?: ProviderConfigSlots },
  ): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {};
    for (const [slot, spec] of Object.entries(factory.configSlots ?? {})) {
      let value: unknown;
      if (spec?.defaultEnv) {
        try {
          value = await thread.env(spec.defaultEnv);
        } catch {
          value = undefined;
        }
      }
      if (value === undefined) value = spec?.default;
      if (value !== undefined) config[slot] = value;
      if (value === undefined && spec?.required) {
        throw new Error(
          `${label} needs provider setting '${slot}'. Set ${spec.defaultEnv ?? slot} in the environment or the thread env.`,
        );
      }
    }
    return config;
  }

  /**
   * A decision provider is built per call and never cached with model providers,
   * so a decision-only provider cannot serve a later model turn.
   */
  async decisionProvider(thread: Thread, factory: DecisionProviderFactory): Promise<DecisionProviderInterface> {
    const config = await this.providerConfig(thread, `Decision provider '${factory.name || 'unknown'}'`, factory);
    return factory(config as never);
  }

  async providerFor(thread: Thread, model: ModelDefinition): Promise<ReturnType<ModelDefinition['provider']>> {
    const cached = this.providers.get(model.name);
    if (cached) return cached;
    const factory = model.provider as unknown as {
      (config: Record<string, unknown>, context?: { state?: ThreadState }): ReturnType<ModelDefinition['provider']>;
      configSlots?: ProviderConfigSlots;
    };
    const config = await this.providerConfig(thread, `Model '${model.name}'`, factory);
    if (config.apiKey === undefined || config.apiKey === '') {
      const guess = `${String(factory.name || model.name).toUpperCase()}_API_KEY`;
      const key = this.envLookup(guess) ?? this.envLookup('OPENAI_API_KEY');
      if (!key) {
        throw new Error(`No API key for provider '${(factory as { name?: string }).name ?? model.name}'. Set ${guess} or OPENAI_API_KEY.`);
      }
      config.apiKey = key;
    }
    const provider = factory(config, { state: thread });
    this.providers.set(model.name, provider);
    return provider;
  }

  async callModel(thread: Thread, prompt: PromptDefinition, request: ProviderRequest): Promise<ProviderResponse> {
    const chain = [prompt.model, ...(this.registry.models.get(unqualify(prompt.model))?.fallbacks ?? [])];
    let lastError: unknown;
    for (const name of chain) {
      const model = this.registry.models.get(unqualify(name));
      if (!model) continue;
      for (let attempt = 0; attempt <= this.providerRetries; attempt++) {
        try {
          const provider = await this.providerFor(thread, model);
          return await provider.generate({
            ...request,
            model: model.model,
            providerOptions: {
              ...(model.providerOptions ?? {}),
              ...(prompt.providerOptions ?? {}),
              ...(request.providerOptions ?? {}),
            },
          });
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ProviderError ? error.isRetryable : false;
          if (!retryable || attempt === this.providerRetries) break;
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'No model available'));
  }

  // ── tool invocation ─────────────────────────────────────────────────────
  async invokeTool(thread: Thread, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.invokeToolUnredacted(thread, name, args);
    return {
      ...result,
      ...(result.result !== undefined ? { result: thread.redact(result.result) } : {}),
      ...(result.error ? { error: thread.redact(result.error) } : {}),
    };
  }

  private async invokeToolUnredacted(thread: Thread, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const caller = this.toolCallStack[this.toolCallStack.length - 1];
    if (caller?.uses && !caller.uses.some((target) => unqualify(target) === unqualify(name))) {
      return { status: 'error', error: `Tool '${name}' is not declared in this tool's 'uses' list` };
    }
    const execution = this.executions.get(thread.threadId);
    if (LIFECYCLE_TOOLS.has(name)) {
      if (!execution) return { status: 'error', error: `'${name}' is only available while the thread is executing` };
      return execution.runLifecycleTool(name as ToolSpec['lifecycle'] & string, args);
    }
    const spec =
      execution?.toolSpecs.find((entry) => entry.name === name && entry.kind !== 'lifecycle') ??
      this.globalToolSpec(name);
    if (!spec) return { status: 'error', error: `Unknown tool '${name}'` };
    return this.runToolSpec(thread, spec, args, execution ?? null);
  }

  private globalToolSpec(name: string): ToolSpec | null {
    const key = unqualify(name);
    const tool = this.registry.tools.get(key);
    if (tool) return { name: key, description: tool.description, parameters: jsonSchemaOf(tool.args), kind: 'function', definition: tool };
    const prompt = this.registry.prompts.get(key);
    if (prompt) return { name: key, description: prompt.toolDescription, parameters: jsonSchemaOf(prompt.requiredSchema), kind: 'prompt', promptName: key };
    const agent = this.registry.agents.get(key);
    if (agent) return { name: key, description: agent.toolDescription ?? agent.description ?? agent.name, parameters: jsonSchemaOf(this.agentArgsSchema(agent)), kind: 'agent', agentName: key };
    return null;
  }

  queueTool(thread: Thread, name: string, args: Record<string, unknown>): void {
    const entry: QueueEntry = { kind: 'tool', id: newId(), side: thread.activeSide ?? 'a', name, args };
    const queue = this.store.loadQueue(thread.threadId);
    queue.push(entry);
    this.store.saveQueue(thread.threadId, queue);
    if (!this.isBusy(thread.threadId)) void this.start(thread, entry.side);
  }

  async runToolSpec(thread: Thread, spec: ToolSpec, args: Record<string, unknown>, execution: Execution | null): Promise<ToolResult> {
    if (spec.kind === 'function') {
      const tool = spec.definition!;
      if (tool.executionMode === 'provider') {
        return { status: 'error', error: `Tool '${spec.name}' is executed by the provider, not the runtime` };
      }
      const validated = validateArgs(tool.args, args);
      if (!validated.ok) return { status: 'error', error: validated.error };
      this.toolCallStack.push({ uses: tool.uses as readonly string[] | undefined });
      try {
        return normalizeToolResult(await (tool.execute as unknown as (state: Thread, args: unknown) => Promise<ToolResult>)(thread, validated.value));
      } finally {
        this.toolCallStack.pop();
      }
    }
    if (spec.kind === 'prompt') {
      return this.runSubPrompt(thread, spec, args);
    }
    if (spec.kind === 'agent') {
      return this.handoff(thread, spec, args);
    }
    if (spec.kind === 'lifecycle') {
      if (!execution) return { status: 'error', error: `'${spec.name}' is only available while the thread is executing` };
      return execution.runLifecycleTool(spec.lifecycle!, args, true);
    }
    return { status: 'error', error: `Unsupported tool kind for '${spec.name}'` };
  }

  /**
   * Prompt tools run a nested model loop. Its messages stay in memory: only the
   * serialized result reaches the caller's thread.
   * shortcut: nested prompt traffic is not persisted with parent_id/depth; persist it when a client needs sub-prompt history.
   */
  async runSubPrompt(thread: Thread, spec: ToolSpec, args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = this.registry.prompts.get(spec.promptName!);
    if (!prompt) return { status: 'error', error: `Unknown prompt '${spec.promptName}'` };
    if (!prompt.model) return { status: 'error', error: `Prompt '${prompt.name}' has no model` };
    const config = spec.config ?? {};
    const validated = validateArgs(prompt.requiredSchema, args);
    if (!validated.ok) return { status: 'error', error: validated.error };
    const initProperty = config.initUserMessageProperty as string | undefined;
    const userContent = initProperty ? asText(args[initProperty]) : JSON.stringify(validated.value);
    const model = this.registry.models.get(unqualify(prompt.model));
    if (!model) return { status: 'error', error: `Unknown model '${prompt.model}'` };
    const tools = (prompt.tools ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.name))
      .filter((name) => !LIFECYCLE_TOOLS.has(name))
      .map((name) => this.globalToolSpec(name))
      .filter((tool): tool is ToolSpec => tool !== null);
    const messages: ProviderMessage[] = [
      { role: 'system', content: await this.renderPrompt(thread, prompt, new Set()) },
      { role: 'user', content: userContent },
    ];
    const texts: string[] = [];
    const toolLog: string[] = [];
    const errors: string[] = [];
    for (let step = 0; step < this.maxSteps; step++) {
      const response = await this.callModel(thread, prompt, {
        model: model.model,
        messages,
        tools: tools.map((tool) => this.providerTool(tool)),
        toolChoice: prompt.toolChoice ?? 'auto',
        parallelToolCalls: prompt.parallelToolCalls,
        signal: this.executions.get(thread.threadId)?.abort.signal,
        user: thread.threadId,
        reasoning: prompt.reasoning
          ? { level: prompt.reasoning.level, maxTokens: prompt.reasoning.maxTokens, exclude: prompt.reasoning.exclude, levels: model.capabilities?.reasoningLevels }
          : undefined,
      });
      if (response.reasoning) {
        messages.push({ role: 'assistant', content: response.content ?? null, reasoning: response.reasoning });
      } else if (response.content) {
        messages.push({ role: 'assistant', content: response.content });
      }
      if (response.content) texts.push(response.content);
      const calls = response.toolCalls ?? [];
      if (!calls.length) break;
      for (const call of calls) {
        const target = tools.find((tool) => tool.name === call.name);
        let result: ToolResult;
        try {
          result = target ? await this.runToolSpec(thread, target, call.arguments, this.executions.get(thread.threadId) ?? null) : { status: 'error', error: `Unknown tool '${call.name}'` };
        } catch (error) {
          result = { status: 'error', error: errorMessage(error) };
        }
        toolLog.push(`${call.name}(${JSON.stringify(call.arguments)}) → ${result.status === 'success' ? result.result ?? '' : `error: ${result.error ?? ''}`}`);
        if (result.status === 'error') errors.push(result.error ?? 'tool failed');
        messages.push({ role: 'assistant', content: null, toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }] });
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.status === 'success' ? result.result ?? '' : `Error: ${result.error ?? ''}` });
      }
    }
    const includeText = config.includeTextResponse ?? true;
    const includeCalls = config.includeToolCalls ?? true;
    const includeErrors = config.includeErrors ?? true;
    const parts: string[] = [];
    if (includeText && texts.length) parts.push(texts[texts.length - 1]);
    if (includeCalls && toolLog.length) parts.push(`Tool calls:\n${toolLog.join('\n')}`);
    if (includeErrors && errors.length) parts.push(`Errors:\n${errors.join('\n')}`);
    return { status: 'success', result: parts.join('\n\n') || 'The sub-prompt returned no content.' };
  }

  /** Hand off the same thread to an exposed agent; its human side waits next. */
  private async handoff(thread: Thread, spec: ToolSpec, args: Record<string, unknown>): Promise<ToolResult> {
    const agent = this.registry.agents.get(spec.agentName!);
    if (!agent) return { status: 'error', error: `Unknown agent '${spec.agentName}'` };
    if (!agent.exposeAsTool) return { status: 'error', error: `Agent '${agent.name}' is not exposed as a tool` };
    const humanSide = agent.sideA.human ? 'a' : agent.sideB?.human ? 'b' : null;
    if (!humanSide) return { status: 'error', error: `Agent '${agent.name}' has no human side; compose it as a subagent instead` };
    const validated = validateArgs(this.agentArgsSchema(agent), args);
    if (!validated.ok) return { status: 'error', error: validated.error };
    thread.data.agent_id = agent.name;
    thread.data.arguments = validated.value;
    thread.save();
    const execution = this.executions.get(thread.threadId);
    if (execution) execution.requestHandoff();
    return { status: 'success', result: `Handed off to ${agent.name}.` };
  }

  agentArgsSchema(agent: AgentDefinition): unknown {
    const side = agent.sideA;
    if (!side?.prompt) return undefined;
    return this.registry.prompts.get(unqualify(side.prompt))?.requiredSchema;
  }

  providerTool(spec: ToolSpec): ProviderTool {
    return {
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    };
  }

  async renderPrompt(thread: Thread, prompt: PromptDefinition, seen: Set<string>): Promise<string> {
    if (seen.has(prompt.name)) throw new Error(`Circular prompt include: ${[...seen, prompt.name].join(' → ')}`);
    seen.add(prompt.name);
    const content = prompt.prompt;
    if (typeof content === 'string') return this.interpolate(thread, content);
    let out = '';
    for (const part of content) {
      if (part.type === 'text') out += await this.interpolate(thread, part.content);
      else if (part.type === 'include') {
        const included = this.registry.prompts.get(unqualify(part.prompt));
        if (included) out += await this.renderPrompt(thread, included, new Set(seen));
      } else if (part.type === 'env') {
        try {
          out += await thread.env(part.property);
        } catch {
          out += '';
        }
      }
    }
    seen.delete(prompt.name);
    return out;
  }

  /**
   * `{{name}}`, `{{arguments.name}}`, `{{env.NAME}}`, `{{context.name}}`.
   * The specification requires argument interpolation but fixes no syntax.
   */
  async interpolate(thread: Thread, text: string): Promise<string> {
    const matches = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((match) => match[1]);
    let out = text;
    for (const key of [...new Set(matches)]) {
      let value: unknown;
      if (key === 'arguments') value = thread.arguments;
      else if (key.startsWith('arguments.')) value = thread.arguments[key.slice('arguments.'.length)];
      else if (key.startsWith('args.')) value = thread.arguments[key.slice('args.'.length)];
      else if (key.startsWith('context.')) value = thread.context[key.slice('context.'.length)];
      else if (key.startsWith('env.')) {
        try {
          value = await thread.env(key.slice('env.'.length));
        } catch {
          value = undefined;
        }
      } else value = thread.arguments[key] ?? thread.context[key];
      if (value === undefined) continue;
      const replacement = typeof value === 'string' ? value : asText(value);
      out = out.split(`{{${key}}}`).join(replacement);
      out = out.replace(new RegExp(`\\{\\{\\s*${key.replace(/\./g, '\\.')}\\s*\\}\\}`, 'g'), replacement);
    }
    return out;
  }

  // ── subagents ───────────────────────────────────────────────────────────
  async spawnImmediate(thread: Thread): Promise<void> {
    const agent = thread.agent;
    for (const [side, config] of [['a', agent.sideA], ['b', agent.sideB]] as const) {
      for (const relationship of config?.subagents ?? []) {
        if (!relationship.immediate) continue;
        if (!relationshipEnabled(relationship, (flag) => thread.data.env[flag] ?? this.envLookup(flag))) continue;
        const hints = typeof relationship.immediate === 'object' ? relationship.immediate : {};
        const name = hints.nameEnv ? thread.data.env[hints.nameEnv] : undefined;
        await this.createChild(thread, side, relationship, {
          name: name ?? relationship.as ?? unqualify(relationship.agent),
          args: {},
          start: false,
        });
      }
    }
  }

  async createChild(
    parent: Thread,
    owningSide: 'a' | 'b',
    relationship: SubagentRelationship,
    options: { name: string; args: Record<string, unknown>; message?: string; attachments?: Array<ToolAttachment | AttachmentRef | string>; start?: boolean },
  ): Promise<{ thread: Thread; entry: ThreadState['children'][number]; attachments?: Array<ToolAttachment | AttachmentRef> }> {
    const childAgent = this.registry.agents.get(unqualify(relationship.agent));
    if (!childAgent) throw new Error(`Undefined subagent '${relationship.agent}'`);
    const relationshipName = relationship.as ?? unqualify(relationship.agent);
    const env: Record<string, string> = {};
    // `scopedEnv` is declared both on the relationship and in the object form of
    // `immediate` (Subagents §1); either list transfers values into the child.
    const scopedEnv = [
      ...(relationship.scopedEnv ?? []),
      ...(typeof relationship.immediate === 'object' ? relationship.immediate.scopedEnv ?? [] : []),
    ];
    const scoped = this.scopedNames(childAgent);
    for (const [key, value] of Object.entries(parent.data.env)) if (!scoped.has(key)) env[key] = value;
    for (const key of scopedEnv) {
      if (parent.data.env[key] !== undefined) env[key] = parent.data.env[key];
      else if (this.envLookup(key) !== undefined) env[key] = this.envLookup(key)!;
    }
    const record = this.store.create({
      agentId: childAgent.name,
      userId: parent.userId,
      arguments: options.args,
      env,
      parentId: parent.threadId,
      owningSide,
      relationship: relationshipName,
      threadName: options.name,
      blocking: !!relationship.blocking,
    });
    const entry: ThreadState['children'][number] = {
      reference: record.id,
      relationship: relationshipName,
      name: childAgent.name,
      title: childAgent.title,
      description: relationship.description ?? childAgent.toolDescription ?? childAgent.description ?? childAgent.name,
      blocking: relationship.blocking,
      threadName: options.name,
      initialArguments: options.args,
      spawnGroupId: relationshipName,
      createdAt: record.created_at,
      status: 'idle',
      parentCommunication: relationship.parentCommunication ?? 'implicit',
    };
    parent.data.children.push(entry);
    parent.save();
    this.notify({ type: 'subagent', reference: entry.reference, relationship: entry.relationship, name: entry.name, status: entry.status });

    const child = this.threadFor(record);
    await this.spawnImmediate(child);
    for (const { hook, context } of parent.runtimeHooks('after_subagent_created')) {
      try {
        await hook.execute(parent, child, context);
      } catch (error) {
        this.log('warn', `after_subagent_created '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    const initProperty = relationship.initUserMessageProperty;
    const content = initProperty ? asText(options.args[initProperty]) : options.message;
    // §8.1: the copy belongs to the child, not to its initial text — a blocking child with
    // no message mapping still gets the files, on the JSON arguments subagent_create queues.
    const attachments = options.attachments?.length ? child.copyAttachmentsFrom(parent, options.attachments) : undefined;
    if (content) {
      await child.queueMessage(
        {
          role: 'user',
          content,
          attachments,
          metadata: { subagent_id: child.threadId, forwarded_from: parent.threadId },
        },
        { trigger: false },
      );
    }
    if (options.start !== false && (content || childAgent.sideA.handler)) {
      if (relationship.blocking) await this.start(child, 'a');
      else void this.start(child, 'a');
    }
    return { thread: child, entry, attachments };
  }

  private scopedNames(agent: AgentDefinition): Set<string> {
    const names = new Set<string>();
    for (const side of [agent.sideA, agent.sideB]) {
      if (!side?.prompt) continue;
      const prompt = this.registry.prompts.get(unqualify(side.prompt));
      for (const variable of prompt?.variables ?? []) if (variable.scoped) names.add(variable.name);
    }
    return names;
  }

  // ── effects ─────────────────────────────────────────────────────────────
  scheduleEffect(thread: Thread, effectId: string): void {
    const key = `${thread.threadId}:${effectId}`;
    if (this.timers.has(key)) return;
    const effect = this.store.loadEffects(thread.threadId).find((entry) => entry.id === effectId);
    if (!effect) return;
    const delayUs = effect.scheduledAt - nowUs();
    const delay = Math.max(0, Math.ceil(delayUs / 1000));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.runEffect(thread.threadId, effectId);
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Run every effect whose time has come (called on startup and before a run). */
  async drainDueEffects(thread: Thread): Promise<void> {
    for (const effect of this.store.loadEffects(thread.threadId)) {
      if (effect.scheduledAt <= nowUs()) await this.runEffect(thread.threadId, effect.id);
      else this.scheduleEffect(thread, effect.id);
    }
  }

  async runEffect(threadId: string, effectId: string): Promise<void> {
    const record = this.store.load(threadId);
    if (!record || record.terminated) return;
    const effects = this.store.loadEffects(threadId).filter((effect) => effect.id !== effectId);
    const scheduled = this.store.loadEffects(threadId).find((effect) => effect.id === effectId);
    if (!scheduled) return;
    this.store.saveEffects(threadId, effects);
    this.timers.delete(`${threadId}:${effectId}`);
    const definition = this.registry.effects.get(unqualify(scheduled.name));
    if (!definition) {
      this.log('warn', `Effect '${scheduled.name}' is not defined`);
      return;
    }
    const [description, argsSchema, handler] = definition as [string, unknown, (state: ThreadState, args: unknown) => unknown];
    const validated = validateArgs(argsSchema, scheduled.args);
    if (!validated.ok) {
      this.log('warn', `Effect '${scheduled.name}' arguments invalid: ${validated.error}`);
      return;
    }
    this.notify({ type: 'effect', id: scheduled.id, name: scheduled.name });
    try {
      await handler(this.threadFor(record), validated.value);
    } catch (error) {
      this.log('error', `Effect '${scheduled.name}' (${description}) failed: ${errorMessage(error)}`);
    }
  }

  // ── hooks helpers (used by Execution) ───────────────────────────────────
  hookEntries(thread: Thread, hookName: string): Array<{ hook: AnyHook; context: HookExecutionContext }> {
    return resolveHooks(this.registry, thread.agent, thread.activePrompt, hookName, (flag) =>
      thread.data.env[flag] ?? thread.agent.env?.[flag] ?? this.envLookup(flag),
    );
  }
}

interface TurnOutcome {
  kind: 'turn' | 'park' | 'session';
  reason: string;
}

class Execution {
  readonly runtime: Runtime;
  readonly thread: Thread;
  readonly flowId = newId();
  readonly abort = new AbortController();
  readonly state: ThreadState['execution'];
  done: Promise<void> = Promise.resolve();
  currentSide: 'a' | 'b';
  stepCount = 0;
  sideAStepCount = 0;
  sideBStepCount = 0;
  toolSpecs: ToolSpec[] = [];
  sessionEnded = false;
  sessionFailed = false;
  sessionStopOptions: SessionStopOptions | null = null;
  private stopped = false;
  private stoppedBy: 'a' | 'b' | undefined;
  private forceTurnSide: 'a' | 'b' | null = null;
  private handoffRequested = false;
  private endReason: string | null = null;
  private sessionTurns = 0;
  private promptPath: string[] = [];
  private sessionAttachments: string[] = [];

  constructor(runtime: Runtime, thread: Thread, triggerSide: 'a' | 'b') {
    this.runtime = runtime;
    this.thread = thread;
    this.currentSide = triggerSide;
    const execution = this;
    this.state = {
      get flowId() {
        return execution.flowId;
      },
      get currentSide() {
        return execution.currentSide;
      },
      get stepCount() {
        return execution.stepCount;
      },
      get sideAStepCount() {
        return execution.sideAStepCount;
      },
      get sideBStepCount() {
        return execution.sideBStepCount;
      },
      get stopped() {
        return execution.stopped;
      },
      get stoppedBy() {
        return execution.stoppedBy;
      },
      get messageHistory() {
        return execution.thread.messages;
      },
      get abortSignal() {
        return execution.abort.signal;
      },
      get promptPath() {
        return execution.promptPath;
      },
      forceTurn: (side: 'a' | 'b') => {
        this.forceTurnSide = side;
      },
      stop: () => {
        this.stopped = true;
        this.stoppedBy = this.currentSide;
      },
    };
  }

  requestStop(options: SessionStopOptions): void {
    this.sessionStopOptions = options;
    this.sessionEnded = true;
    this.sessionFailed = false;
    this.endReason = 'state_stop_session';
  }

  requestHandoff(): void {
    this.handoffRequested = true;
    this.stopped = true;
    this.endReason = 'forced_human_turn';
  }

  /** Log lines can quote tool output, so thread secrets never reach the sink unmasked. */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.runtime.log(level, this.thread.redact(message));
  }

  async run(): Promise<void> {
    const started = nowUs();
    this.thread.lastSessionResult = null;
    this.thread.data.status = { state: 'running', since: started, reason: null };
    this.thread.save();
    this.runtime.notify({ type: 'status', status: this.thread.data.status });
    try {
      await this.drainQueuedTools();
      await this.loop();
    } catch (error) {
      this.endReason = this.endReason ?? 'fatal_error';
      this.sessionFailed = true;
      this.log('error', `${this.thread.agentId}/${this.thread.threadId}: ${errorMessage(error)}`);
      this.runtime.onEvent?.({ type: 'error', message: errorMessage(error) });
    } finally {
      await this.settle();
    }
  }

  private async loop(): Promise<void> {
    const agent = this.thread.agent;
    let side = this.currentSide;
    while (!this.sessionEnded && !this.stopped) {
      if (this.thread.data.terminated || this.abort.signal.aborted) {
        this.endReason = 'aborted';
        break;
      }
      if (agent.maxSessionTurns !== undefined && this.sessionTurns >= agent.maxSessionTurns) {
        this.endReason = 'max_session_turns';
        this.sessionEnded = true;
        break;
      }
      if (this.stepCount >= this.runtime.maxTotalSteps) {
        this.endReason = 'max_total_steps';
        break;
      }
      this.currentSide = side;
      this.thread.activeSide = side;
      const config: SideConfig = side === 'a' ? agent.sideA : agent.sideB;
      const outcome = await this.takeTurn(side, config);
      if (this.sessionEnded || outcome.kind === 'session') {
        this.endReason = this.endReason ?? outcome.reason;
        this.sessionEnded = true;
        break;
      }
      if (outcome.kind === 'park' || this.stopped) {
        this.endReason = this.endReason ?? outcome.reason;
        break;
      }
      this.sessionTurns++;
      const next = this.forceTurnSide ?? (side === 'a' ? 'b' : 'a');
      this.forceTurnSide = null;
      side = next;
      if (this.handoffRequested) break;
    }
    if (this.sessionEnded) await this.deliverToParent();
  }

  private async takeTurn(side: 'a' | 'b', config: SideConfig): Promise<TurnOutcome> {
    if ('human' in config && config.human) {
      await this.thread.setStatus('awaiting_human');
      return { kind: 'park', reason: 'awaiting_human' };
    }
    if ('handler' in config && config.handler) return this.handlerTurn(side, config);
    return this.promptTurn(side, config as PromptSide);
  }

  private async handlerTurn(side: 'a' | 'b', config: { handler: string }): Promise<TurnOutcome> {
    const handler = this.runtime.registry.handlers.get(unqualify(config.handler));
    if (!handler) throw new Error(`Handler '${config.handler}' is not defined`);
    let delivered = 0;
    for (const message of this.thread.messages) {
      if (this.sessionEnded || this.stopped) break;
      if (message.role === 'tool' || message.role === 'system') continue;
      const metadata = (message.metadata ??= {});
      if (sideOfMessage(message) === side) continue;
      if (metadata.handler_delivered) continue;
      metadata.handler_delivered = true;
      this.thread.store.saveMessages(this.thread.threadId, this.thread.messages);
      delivered++;
      try {
        await handler.execute(this.thread, message);
      } catch (error) {
        this.runtime.onEvent?.({ type: 'error', message: `Handler '${config.handler}' failed: ${errorMessage(error)}` });
        this.log('error', `Handler '${config.handler}' failed: ${errorMessage(error)}`);
      }
    }
    return { kind: 'turn', reason: delivered ? 'handler_turn' : 'handler_idle' };
  }

  private async promptTurn(side: 'a' | 'b', config: PromptSide): Promise<TurnOutcome> {
    const prompt = this.runtime.registry.prompts.get(unqualify(config.prompt));
    if (!prompt) throw new Error(`Prompt '${config.prompt}' is not defined`);
    this.thread.activePrompt = prompt.name;
    this.thread.activeEnvDefaults = { ...(prompt.env ?? {}) };
    this.toolSpecs = this.buildToolSpecs(prompt, config, side);
    this.stopToolHit = false;
    const maxSteps = config.maxSteps ?? this.runtime.maxSteps;
    let steps = 0;
    let outcome: TurnOutcome = { kind: 'turn', reason: 'max_side_steps' };
    while (steps < maxSteps) {
      if (this.stopped || this.sessionEnded || this.abort.signal.aborted) break;
      steps++;
      this.stepCount++;
      if (side === 'a') this.sideAStepCount++;
      else this.sideBStepCount++;
      this.promptPath = [prompt.name];

      await this.drainQueuedTools();
      const request = await this.buildRequest(prompt, side);
      let response: ProviderResponse;
      try {
        response = await this.runtime.callModel(this.thread, prompt, request);
      } catch (error) {
        this.log('error', `Model call failed (${prompt.model}): ${errorMessage(error)}`);
        this.runtime.onEvent?.({ type: 'error', message: `Model call failed (${prompt.model}): ${errorMessage(error)}` });
        this.endReason = 'step_error';
        this.sessionFailed = true;
        return { kind: 'session', reason: 'step_error' };
      }

      const calls = response.toolCalls ?? [];
      await this.thread.persist({
        role: side === 'a' ? 'assistant' : 'user',
        content: response.content ?? null,
        tool_calls: calls.length ? toolCallJson(calls) : null,
        reasoning_content: response.reasoning ?? null,
        reasoning_details: response.reasoningDetails?.length ? JSON.stringify(response.reasoningDetails) : null,
        metadata: {
          ...(response.usage ? { usage: response.usage } : {}),
          ...(response.metadata ? { provider_metadata: response.metadata } : {}),
        },
        prompt: prompt.name,
      });

      if (calls.length) {
        let stopTurn = false;
        for (const call of calls) {
          await this.executeToolCall(call, side, config, prompt.name);
          if (this.sessionEnded) break;
          if (this.stopToolHit) {
            stopTurn = true;
            break;
          }
        }
        if (this.sessionEnded) return { kind: 'session', reason: this.endReason ?? 'session_stop' };
        if (this.stopped) return { kind: 'turn', reason: this.endReason ?? 'aborted' };
        if (stopTurn) return { kind: 'turn', reason: 'stop_tool' };
        continue;
      }

      if (config.stopOnResponse ?? true) return { kind: 'turn', reason: 'stop_on_response' };
      outcome = { kind: 'turn', reason: 'max_side_steps' };
    }
    return outcome;
  }

  private stopToolHit = false;

  private buildToolSpecs(prompt: PromptDefinition, config: PromptSide, side: 'a' | 'b'): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const entry of prompt.tools ?? []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const options = typeof entry === 'string' ? {} : (entry as unknown as Record<string, unknown>);
      if (LIFECYCLE_TOOLS.has(name)) continue;
      const tool = this.runtime.registry.tools.get(unqualify(name));
      if (tool) {
        specs.push({ name: unqualify(name), description: tool.description, parameters: jsonSchemaOf(tool.args), kind: 'function', definition: tool });
        continue;
      }
      const subPrompt = this.runtime.registry.prompts.get(unqualify(name));
      if (subPrompt) {
        specs.push({
          name: unqualify(name),
          description: subPrompt.toolDescription,
          parameters: jsonSchemaOf(subPrompt.requiredSchema),
          kind: 'prompt',
          promptName: subPrompt.name,
          config: options,
        });
        if (options.env && typeof options.env === 'object') Object.assign(this.thread.activeEnvDefaults, options.env);
        continue;
      }
      const agent = this.runtime.registry.agents.get(unqualify(name));
      if (agent) {
        specs.push({
          name: unqualify(name),
          description: (options.description as string) ?? agent.toolDescription ?? agent.description ?? agent.name,
          parameters: jsonSchemaOf(this.runtime.agentArgsSchema(agent)),
          kind: 'agent',
          agentName: agent.name,
          config: options,
        });
      }
    }

    // Runtime-injected lifecycle tools for this side's enabled, non-hidden relationships (Subagents §5).
    const relationships = (config.subagents ?? []).filter(
      (relationship) => !relationship.hidden && relationshipEnabled(relationship, (flag) => this.thread.data.env[flag] ?? this.runtime.instanceEnv(flag)),
    );
    if (relationships.length) {
      const names = relationships.map((relationship) => relationship.as ?? unqualify(relationship.agent));
      const descriptions = relationships.map(
        (relationship) =>
          `${relationship.as ?? unqualify(relationship.agent)}: ${relationship.description ?? this.runtime.registry.agents.get(unqualify(relationship.agent))?.toolDescription ?? ''}`,
      );
      specs.push(
        { name: 'subagents', description: 'List the subagent instances of this side and their status.', kind: 'lifecycle', lifecycle: 'subagents' },
        {
          name: 'subagent_create',
          description: `Create a subagent instance. Call subagents first to reuse an existing instance.\n${descriptions.join('\n')}`,
          kind: 'lifecycle',
          lifecycle: 'subagent_create',
          parameters: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: names },
              name: { type: 'string', description: 'Human-readable name for the instance' },
              arguments: { type: 'object', description: 'Structured arguments for the child prompt' },
              message: { type: 'string', description: 'Initial message when the child has no argument mapping' },
            },
            required: ['agent', 'name'],
          },
        },
        {
          name: 'subagent_message',
          description: 'Queue a message to an existing subagent instance by reference.',
          kind: 'lifecycle',
          lifecycle: 'subagent_message',
          parameters: {
            type: 'object',
            properties: {
              reference: { type: 'string', description: 'Instance reference from subagents' },
              agent: { type: 'string', enum: names },
              message: { type: 'string' },
              attachments: { type: 'array', items: { type: 'string' }, description: 'Parent file paths to copy into the subagent' },
            },
            required: ['message'],
          },
        },
      );
    }
    return specs;
  }

  // ── context assembly ────────────────────────────────────────────────────
  private async buildRequest(prompt: PromptDefinition, side: 'a' | 'b'): Promise<ProviderRequest> {
    const thread = this.thread;
    let system = await this.runtime.renderPrompt(thread, prompt, new Set());
    for (const { hook, context } of this.runtime.hookEntries(thread, 'after_system_message')) {
      try {
        const next = await hook.execute(thread, system, context);
        if (typeof next === 'string') system = next;
      } catch (error) {
        this.log('warn', `after_system_message '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    let snapshot: HookMessage[] = this.eligibleHistory(prompt, side);
    for (const { hook, context } of this.runtime.hookEntries(thread, 'filter_messages')) {
      try {
        snapshot = await hook.execute(thread, snapshot, context);
      } catch (error) {
        this.log('warn', `filter_messages '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    const model = this.runtime.registry.models.get(unqualify(prompt.model));
    let messages: LLMMessage[] = [
      this.systemMessage(system),
      ...(await this.toProviderMessages(prompt, side, snapshot, model)),
    ];
    for (const { hook, context } of this.runtime.hookEntries(thread, 'prefilter_llm_history')) {
      try {
        messages = await hook.execute(thread, messages as never, context);
      } catch (error) {
        this.log('warn', `prefilter_llm_history '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    const tools = this.toolSpecs.map((spec) => this.runtime.providerTool(spec));
    return {
      model: model?.model ?? prompt.model,
      messages: messages as ProviderMessage[],
      tools: tools.length ? tools : undefined,
      toolChoice: prompt.toolChoice ?? (tools.length ? 'auto' : 'none'),
      parallelToolCalls: prompt.parallelToolCalls,
      signal: this.abort.signal,
      user: thread.threadId,
      reasoning: prompt.reasoning
        ? { level: prompt.reasoning.level, maxTokens: prompt.reasoning.maxTokens, exclude: prompt.reasoning.exclude, levels: model?.capabilities?.reasoningLevels }
        : undefined,
      providerOptions: prompt.providerOptions,
    };
  }

  private systemMessage(system: string): LLMMessage {
    return { role: 'system', content: system };
  }

  /** Persisted history eligible for this request, before `filter_messages`. */
  private eligibleHistory(prompt: PromptDefinition, side: 'a' | 'b'): HookMessage[] {
    let rows = this.thread.messages.filter((message) => (message.depth ?? 0) === 0);
    if (!prompt.includeChat) {
      let lastOwn = -1;
      rows.forEach((message, index) => {
        if (sideOfMessage(message) === side && message.role !== 'tool') lastOwn = index;
      });
      if (lastOwn >= 0) rows = rows.slice(lastOwn + 1);
    }
    const limit = prompt.historyLimit;
    if (limit && rows.length > limit) {
      const keep = Math.ceil(rows.length / limit) * limit;
      rows = rows.slice(Math.max(0, rows.length - keep));
    }
    return rows.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      name: message.name,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      created_at: message.created_at,
      parent_id: message.parent_id,
      depth: message.depth,
      silent: message.silent,
      metadata: message.metadata,
      attachments: message.attachments,
      reasoning_content: message.reasoning_content,
      reasoning_details: message.reasoning_details,
    })) as HookMessage[];
  }

  private async toProviderMessages(
    prompt: PromptDefinition,
    side: 'a' | 'b',
    rows: HookMessage[],
    model: ModelDefinition | undefined,
  ): Promise<LLMMessage[]> {
    const includePastTools = prompt.includePastTools ?? false;
    const threshold = prompt.recentImageThreshold ?? 10;
    const out: LLMMessage[] = [];
    for (const [index, message] of rows.entries()) {
      if (message.role === 'system') continue;
      const own = sideOfMessage(message) === side;
      if (message.role === 'tool') {
        if (!includePastTools || !own) continue;
        out.push({
          role: 'tool',
          toolCallId: message.tool_call_id,
          toolName: message.name,
          content: message.content ?? '',
        });
        continue;
      }
      const content = await this.contentFor(message as Message, rows.length - index <= threshold, model);
      if (own) {
        const calls = includePastTools ? parseToolCalls(message.tool_calls) : [];
        const row: LLMMessage = {
          role: 'assistant',
          content: content ?? null,
          ...(calls.length ? { toolCalls: calls } : {}),
        };
        if (prompt.reasoning?.include !== false) {
          const reasoning = (message as Message).reasoning_content;
          if (reasoning) row.reasoning = reasoning;
          const details = parseJson<unknown[] | null>((message as Message).reasoning_details, null);
          if (details) row.reasoningDetails = details;
        }
        out.push(row);
      } else {
        if (!content || (typeof content === 'string' && content.trim() === '')) continue;
        out.push({ role: 'user', content });
      }
    }
    // Provider messages must be strictly alternating tool calls with results; drop orphan tool rows.
    const cleaned: LLMMessage[] = [];
    for (const row of out) {
      if (
        row.role === 'tool' &&
        !cleaned.some(
          (prev) =>
            Array.isArray(prev.toolCalls) &&
            (prev.toolCalls as Array<{ id: string }>).some((call) => call.id === row.toolCallId),
        )
      ) {
        continue;
      }
      cleaned.push(row);
    }
    return cleaned;
  }

  private async contentFor(
    message: Message,
    recentImage: boolean,
    model: ModelDefinition | undefined,
  ): Promise<string | Array<Record<string, unknown>> | null> {
    const text = message.content ?? '';
    const attachments = message.attachments ?? [];
    if (!attachments.length) return text;
    const supportsImages = model?.capabilities?.supportsImages ?? false;
    const parts: Array<Record<string, unknown>> = [];
    if (text) parts.push({ type: 'text', text });
    for (const attachment of attachments) {
      const isImage = attachment.mimeType?.startsWith('image/');
      if (isImage && recentImage && supportsImages) {
        const data = this.thread.files.readFile(attachment.path);
        if (data) {
          parts.push({
            type: 'image',
            data: Buffer.from(data).toString('base64'),
            mediaType: attachment.mimeType,
          });
          continue;
        }
      }
      parts.push({ type: 'text', text: `[${isImage ? 'image' : 'file'}: ${attachment.name}]` });
    }
    return parts.length === 1 && parts[0].type === 'text' ? String(parts[0].text) : parts;
  }

  // ── tool execution ──────────────────────────────────────────────────────
  private async executeQueuedTool(entry: QueueEntry & { kind: 'tool' }): Promise<void> {
    await this.thread.persist({
      role: entry.side === 'a' ? 'assistant' : 'user',
      content: null,
      tool_calls: toolCallJson([{ id: entry.id, name: entry.name, arguments: entry.args }]),
      silent: true,
      metadata: { queued_tool: true },
    });
    await this.executeToolCall({ id: entry.id, name: entry.name, arguments: entry.args }, entry.side, null, this.thread.activePrompt);
  }

  private async drainQueuedTools(): Promise<void> {
    const tools = await this.thread.drainQueue();
    for (const entry of tools) {
      if (entry.kind === 'tool') await this.executeQueuedTool(entry);
    }
  }

  private async executeToolCall(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    side: 'a' | 'b',
    config: PromptSide | null,
    promptName: string | null,
  ): Promise<void> {
    const spec = this.toolSpecs.find((entry) => entry.name === call.name);
    const toolCall: HookToolCall = { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
    const progress = spec?.definition?.progressArgument ? asText(call.arguments[spec.definition.progressArgument]) : undefined;
    this.runtime.onEvent?.({ type: 'tool_started', name: call.name, progress });
    for (const { hook, context } of this.runtime.hookEntries(this.thread, 'tool_call_started')) {
      try {
        await hook.execute(this.thread, toolCall, progress, context);
      } catch (error) {
        this.log('warn', `tool_call_started '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    let result: ToolResult;
    try {
      result = spec
        ? await this.runtime.runToolSpec(this.thread, spec, call.arguments, this)
        : { status: 'error', error: `Unknown tool '${call.name}'` };
    } catch (error) {
      result = { status: 'error', error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined };
    }

    result = await this.applyToolHook('before_store_tool_result', toolCall, result);
    result =
      result.status === 'success'
        ? await this.applyToolHook('after_tool_call_success', toolCall, result)
        : await this.applyToolHook('after_tool_call_failure', toolCall, result);

    const attachments = await this.thread.materializeAttachments(result.attachments ?? []);
    await this.thread.persist({
      role: 'tool',
      content: result.status === 'success' ? (result.result ?? '') : (result.error ?? 'Tool failed'),
      name: call.name,
      tool_call_id: call.id,
      tool_status: result.status,
      metadata: { side },
      attachments: attachments.length ? attachments : null,
      prompt: promptName,
    });
    this.runtime.onEvent?.({ type: 'tool_done', name: call.name, status: result.status, error: result.error });
    for (const { hook, context } of this.runtime.hookEntries(this.thread, 'tool_call_done')) {
      try {
        await hook.execute(this.thread, toolCall, result as HookToolResult, context);
      } catch (error) {
        this.log('warn', `tool_call_done '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }

    this.applyStopBindings(call, result, config, side);
  }

  private async applyToolHook(name: string, toolCall: HookToolCall, result: ToolResult): Promise<ToolResult> {
    let current = result;
    for (const { hook, context } of this.runtime.hookEntries(this.thread, name)) {
      try {
        const next = await hook.execute(this.thread, toolCall, current as HookToolResult, context);
        if (next) current = next as ToolResult;
      } catch (error) {
        this.log('warn', `${name} '${hook.id}' failed: ${errorMessage(error)}`);
      }
    }
    return current;
  }

  private applyStopBindings(
    call: { name: string; arguments: Record<string, unknown> },
    result: ToolResult,
    config: PromptSide | null,
    side: 'a' | 'b',
  ): void {
    if (!config) return;
    const extract = (binding: NonNullable<PromptSide['sessionStop']>): string => {
      const value = binding.messageProperty ? call.arguments[binding.messageProperty] : undefined;
      return value !== undefined ? asText(value) : result.result ?? '';
    };
    const attachmentPaths = (binding: NonNullable<PromptSide['sessionStop']>): string[] => {
      const value = binding.attachmentsProperty ? call.arguments[binding.attachmentsProperty] : undefined;
      if (!value) return [];
      return Array.isArray(value) ? value.map(String) : [String(value)];
    };

    if (config.sessionStop && call.name === config.sessionStop.name) {
      this.thread.lastSessionResult = extract(config.sessionStop);
      this.sessionAttachments = attachmentPaths(config.sessionStop);
      this.sessionEnded = true;
      this.sessionFailed = false;
      this.endReason = 'session_stop';
      return;
    }
    if (config.sessionFail && call.name === config.sessionFail.name) {
      this.thread.lastSessionResult = extract(config.sessionFail);
      this.sessionAttachments = attachmentPaths(config.sessionFail);
      this.sessionEnded = true;
      this.sessionFailed = true;
      this.endReason = 'session_fail';
      return;
    }
    if (config.sessionStatus && call.name === config.sessionStatus.name) {
      const message = config.sessionStatus.messageProperty
        ? asText(call.arguments[config.sessionStatus.messageProperty])
        : result.result ?? '';
      void this.thread.setStatus(message || 'running');
      return;
    }
    if (config.stopTool && call.name === config.stopTool) {
      this.stopToolHit = true;
      const property = config.stopToolResponseProperty;
      this.thread.lastSessionResult = property ? asText(call.arguments[property]) : result.result ?? null;
    }
  }

  // ── lifecycle tools ─────────────────────────────────────────────────────
  async runLifecycleTool(name: string, args: Record<string, unknown>, modelCall = false): Promise<ToolResult> {
    const side = this.currentSide;
    const config = side === 'a' ? this.thread.agent.sideA : this.thread.agent.sideB;
    const relationships = (config?.subagents ?? []).filter((relationship) =>
      relationshipEnabled(relationship, (flag) => this.thread.data.env[flag] ?? this.runtime.instanceEnv(flag)),
    );
    const visible = modelCall ? relationships.filter((relationship) => !relationship.hidden) : relationships;
    const relationshipOf = (label: string): SubagentRelationship | undefined =>
      relationships.find((relationship) => (relationship.as ?? unqualify(relationship.agent)) === label);

    if (name === 'subagents') {
      const rows = this.thread.children
        .filter((child) => relationships.some((relationship) => (relationship.as ?? unqualify(relationship.agent)) === child.relationship))
        .map((child) => ({
          reference: child.reference,
          relationship: child.relationship,
          agent: child.name,
          status: child.status,
          name: child.threadName,
          arguments: child.initialArguments,
          created_at: child.createdAt,
        }));
      return { status: 'success', result: JSON.stringify(rows) };
    }

    if (name === 'subagent_create') {
      const label = String(args.agent ?? '');
      const relationship = relationshipOf(label);
      if (!relationship || (modelCall && !visible.includes(relationship))) {
        return { status: 'error', error: `'${label}' is not an enabled relationship on this side. Available: ${visible.map((r) => r.as ?? unqualify(r.agent)).join(', ') || 'none'}` };
      }
      const instanceName = String(args.name ?? '').trim();
      if (!instanceName) return { status: 'error', error: 'subagent_create requires a non-empty name' };
      const childAgent = this.runtime.registry.agents.get(unqualify(relationship.agent));
      if (!childAgent) return { status: 'error', error: `Undefined subagent '${relationship.agent}'` };
      const initialArguments = (
        typeof args.arguments === 'string'
          ? parseJson<Record<string, unknown>>(args.arguments, {})
          : args.arguments && typeof args.arguments === 'object'
            ? args.arguments
            : {}
      ) as Record<string, unknown>;
      const existing = this.thread.children.filter((child) => child.relationship === (relationship.as ?? unqualify(relationship.agent)));
      const cap = relationship.maxInstances;
      let mode: 'create' | 'continue' = 'create';
      if (cap !== undefined && existing.length >= cap) {
        if (relationship.blocking && cap === 1 && existing.length) {
          mode = 'continue';
        } else {
          return {
            status: 'error',
            error: `Relationship '${relationship.as ?? unqualify(relationship.agent)}' is at its maxInstances (${cap}). Message an existing instance with subagent_message instead.`,
          };
        }
      }
      const schema = childAgent.sideA?.prompt ? this.runtime.registry.prompts.get(unqualify(childAgent.sideA.prompt))?.requiredSchema : undefined;
      const validated = validateArgs(schema, initialArguments);
      if (!validated.ok) {
        return { status: 'error', error: `subagent_arguments_required: ${validated.error}`, error_code: 'subagent_arguments_required' };
      }
      const declaredAttachments = asAttachmentList(
        relationship.initAttachmentsProperty ? validated.value[relationship.initAttachmentsProperty] : undefined,
      );

      let child: Thread;
      if (mode === 'continue') {
        const loaded = await this.thread.getChildThread(existing[existing.length - 1].reference);
        if (!loaded) return { status: 'error', error: 'Existing instance could not be loaded' };
        child = loaded;
        const content = relationship.initUserMessageProperty
          ? asText(validated.value[relationship.initUserMessageProperty])
          : asText(args.message ?? validated.value.message ?? '');
        const attachments = declaredAttachments.length ? child.copyAttachmentsFrom(this.thread, declaredAttachments) : undefined;
        if (content) {
          await child.queueMessage({ role: 'user', content, attachments });
        }
        await this.runtime.start(child, 'a');
        const result = child.lastSessionResult ?? 'The subagent session ended without a result.';
        return { status: 'success', result };
      }

      const created = await this.runtime.createChild(this.thread, side, relationship, {
        name: instanceName,
        args: validated.value,
        message: typeof args.message === 'string' ? args.message : undefined,
        start: false,
        attachments: declaredAttachments,
      });
      child = created.thread;
      const kickoff = relationship.initUserMessageProperty ? asText(validated.value[relationship.initUserMessageProperty]) : undefined;
      const hasMessage = Boolean(kickoff || args.message);
      if (relationship.blocking && !hasMessage) {
        await child.queueMessage({ role: 'user', content: JSON.stringify(validated.value), attachments: created.attachments }, { trigger: false });
      }
      if (hasMessage || relationship.blocking) {
        if (relationship.blocking) await this.runtime.start(child, 'a');
        else void this.runtime.start(child, 'a');
      }
      if (relationship.blocking) {
        const result = child.lastSessionResult ?? 'The subagent session ended without a result.';
        return { status: 'success', result };
      }
      return { status: 'success', result: `Started ${instanceName} (${relationship.as ?? unqualify(relationship.agent)}). Reference: ${child.threadId}.` };
    }

    if (name === 'subagent_message') {
      const reference = typeof args.reference === 'string' ? args.reference : undefined;
      const label = typeof args.agent === 'string' ? args.agent : undefined;
      let child: Thread | null = null;
      if (reference) child = await this.thread.getChildThread(reference);
      else if (label) {
        const relationship = relationshipOf(label);
        if (!relationship) return { status: 'error', error: `'${label}' is not a declared relationship on this side` };
        const candidates = this.thread.children.filter((entry) => entry.relationship === (relationship.as ?? unqualify(relationship.agent)));
        const last = candidates[candidates.length - 1];
        if (last) child = await this.thread.getChildThread(last.reference);
      }
      if (!child) return { status: 'error', error: 'No matching subagent instance' };
      const content = asText(args.message ?? args.content ?? '');
      if (!content) return { status: 'error', error: 'subagent_message requires a message' };
      // §8.1 also covers later messaging: the parent names a file, the child gets its own copy.
      const attachments = child.copyAttachmentsFrom(this.thread, asAttachmentList(args.attachments));
      await child.queueMessage({
        role: 'user',
        content,
        attachments: attachments.length ? attachments : undefined,
        metadata: { subagent_id: child.threadId },
      });
      void this.runtime.start(child, 'a');
      return { status: 'success', result: `Queued a message to ${child.threadId}.` };
    }

    return { status: 'error', error: `Unknown lifecycle tool '${name}'` };
  }

  // ── settling ────────────────────────────────────────────────────────────
  private async settle(): Promise<void> {
    const status = this.sessionFailed
      ? { state: 'failed' as const, since: nowUs(), reason: this.endReason ?? 'fatal_error' }
      : { state: 'idle' as const, since: nowUs(), reason: this.endReason ?? (this.stopped ? 'aborted' : 'stop_on_response') };
    this.thread.data.status = status;
    this.thread.save();
    this.thread.activePrompt = null;
    this.thread.activeSide = null;
    this.runtime.notify({ type: 'status', status });
    await this.thread.setStatus(status.state === 'failed' ? 'failed' : this.endReason === 'awaiting_human' ? 'awaiting_human' : 'idle');
  }

  private async deliverToParent(): Promise<void> {
    if (!this.thread.data.parent_id) return;
    const parent = await this.thread.getParentThread();
    if (!parent) return;
    const entry = parent.children.find((child) => child.reference === this.thread.threadId);
    if (!entry) return;
    const mode = entry.parentCommunication ?? 'implicit';
    entry.status = this.sessionFailed ? 'failed' : 'idle';
    parent.save();
    if (mode === 'explicit') return;
    const result = this.thread.lastSessionResult ?? this.sessionStopOptions?.result ?? 'The session ended without a result.';
    const label = this.sessionFailed ? 'has reported a failure' : 'has returned the following result';
    const attachments: AttachmentRef[] = [];
    for (const childPath of this.sessionAttachments) {
      try {
        const record = parent.files.importFrom(this.thread.store.filesRoot(this.thread.threadId), childPath);
        attachments.push({ id: record.path, type: 'file', path: record.path, name: record.name, mimeType: record.mimeType, size: record.size });
      } catch (error) {
        this.log('warn', `Could not copy attachment '${childPath}' to the parent: ${errorMessage(error)}`);
      }
    }
    await parent.queueMessage({
      role: this.thread.parentInboundRole,
      content: `Subagent (reference: ${this.thread.threadId}) ${label}:\n\n${result}`,
      silent: true,
      attachments: attachments.length ? attachments : undefined,
      metadata: { subagent_id: this.thread.threadId },
    });
  }
}

