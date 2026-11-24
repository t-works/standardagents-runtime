import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ModelDefinition, ProviderMessage, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '@standardagents/spec';
import { loadSource } from './loader.ts';
import { Runtime } from './runtime.ts';
import { ThreadStore } from './store.ts';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** A model that replays a fixed script and records every request it is given. */
function scripted(script: ProviderResponse[]): { requests: ProviderRequest[]; provider: ModelDefinition['provider'] } {
  const requests: ProviderRequest[] = [];
  const provider = (() => ({
    name: 'capture',
    specificationVersion: '1',
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      return script[Math.min(requests.length, script.length) - 1];
    },
    async stream(): Promise<AsyncIterable<ProviderStreamChunk>> {
      throw new Error('the capture provider does not stream');
    },
  })) as unknown as ModelDefinition['provider'];
  return { requests, provider };
}

function blank(row: ProviderMessage): boolean {
  const content = row.content as unknown;
  const hasText = typeof content === 'string' ? content.trim() !== '' : Array.isArray(content) && content.length > 0;
  const hasCalls = Array.isArray((row as { toolCalls?: unknown[] }).toolCalls) && (row as { toolCalls: unknown[] }).toolCalls.length > 0;
  return row.role === 'assistant' && !hasText && !hasCalls;
}

type Thread = Awaited<ReturnType<Runtime['createThread']>>;

async function run(
  request: string,
  script: ProviderResponse[],
  tweak: (registry: Awaited<ReturnType<typeof loadSource>>['registry']) => void,
  onRequest?: (index: number, thread: Thread) => Promise<void> | void,
): Promise<ProviderRequest[]> {
  const root = mkdtempSync(path.join(tmpdir(), 'sa-context-'));
  try {
    const { registry } = await loadSource(FIXTURES);
    const { requests, provider } = scripted(script);
    const factory = provider as unknown as () => { generate: (request: ProviderRequest) => Promise<ProviderResponse> };
    const wrapped = (() => {
      const instance = factory();
      if (!onRequest) return instance;
      const reply = instance.generate.bind(instance);
      return {
        ...instance,
        generate: async (request: ProviderRequest) => {
          const captured = await reply(request);
          await onRequest(requests.length, thread);
          return captured;
        },
      };
    }) as unknown as ModelDefinition['provider'];
    registry.models.set('scripted', { ...registry.models.get('scripted')!, provider: wrapped });
    tweak(registry);
    const runtime = new Runtime({
      store: new ThreadStore(root, { keyFile: path.join(root, 'store.key') }),
      registry,
      instanceEnv: (name) => (name === 'OPENAI_API_KEY' ? 'dummy' : undefined),
    });
    const thread = await runtime.createThread({ agentId: 'probe' });
    await thread.queueMessage({ role: 'user', content: request });
    await runtime.settle();
    return requests;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const roles = (request: ProviderRequest): string[] => request.messages.map((row) => row.role);
const callIds = (request: ProviderRequest): string[] =>
  request.messages.flatMap((row) => ((row as unknown as { toolCalls?: Array<{ id: string }> }).toolCalls ?? []).map((call) => call.id));
const toolIds = (request: ProviderRequest): string[] =>
  request.messages.flatMap((row) => ((row as unknown as { toolCallId?: string }).toolCallId ? [(row as unknown as { toolCallId: string }).toolCallId] : []));

/**
 * With `includePastTools` off, the turn in progress keeps every call and result
 * it made: the step cannot continue without its own exchange, and a cutoff
 * inside one turn makes the model redo work it already did.
 */
test('past tools off keeps the calls and results of the turn in progress', async () => {
  const requests = await run(
    'go',
    [
      { content: null, finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'record', arguments: { value: 'one' } }], usage: ZERO_USAGE },
      { content: null, finishReason: 'tool_calls', toolCalls: [{ id: 'call_2', name: 'record', arguments: { value: 'two' } }], usage: ZERO_USAGE },
      { content: 'done', finishReason: 'stop', usage: ZERO_USAGE },
    ],
    (registry) => {
      const prompt = registry.prompts.get('probe_prompt')!;
      registry.prompts.set('probe_prompt', { ...prompt, includePastTools: false });
    },
  );

  assert.equal(requests.length, 3, 'the run took three steps');
  assert.deepEqual(roles(requests[1]), ['system', 'user', 'assistant', 'tool'], 'the first step keeps its call and result');
  assert.deepEqual(callIds(requests[1]), ['call_1']);
  assert.deepEqual(toolIds(requests[1]), ['call_1']);
  assert.deepEqual(callIds(requests[2]), ['call_1', 'call_2'], 'the second step keeps both exchanges of the same turn');
  assert.deepEqual(toolIds(requests[2]), ['call_1', 'call_2']);
  for (const [index, request] of requests.entries()) {
    assert.ok(!request.messages.some(blank), `request ${index + 1} carries no empty assistant row`);
  }
});

/** A turn boundary is the newest message from the other side; older exchanges go whole. */
test("past tools off drops the previous turn's exchange and keeps the newest", async () => {
  const requests = await run(
    'go',
    [
      { content: null, finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'record', arguments: { value: 'one' } }], usage: ZERO_USAGE },
      { content: 'noted', finishReason: 'stop', usage: ZERO_USAGE },
      { content: 'done', finishReason: 'stop', usage: ZERO_USAGE },
    ],
    (registry) => {
      const prompt = registry.prompts.get('probe_prompt')!;
      registry.prompts.set('probe_prompt', { ...prompt, includePastTools: false });
    },
    async (index, thread) => {
      if (index === 2) await thread.queueMessage({ role: 'user', content: 'next turn' });
    },
  );

  assert.equal(requests.length, 3, 'the queued message started a second turn');
  assert.deepEqual(callIds(requests[1]), ['call_1'], 'the first turn keeps its call and result');
  assert.deepEqual(toolIds(requests[1]), ['call_1']);
  assert.deepEqual(callIds(requests[2]), [], 'the second turn carries no calls from the first');
  assert.deepEqual(toolIds(requests[2]), []);
  assert.deepEqual(roles(requests[2]), ['system', 'user', 'assistant', 'user'], 'the older call row stays as plain text');
  for (const [index, request] of requests.entries()) {
    assert.ok(!request.messages.some(blank), `request ${index + 1} carries no empty assistant row`);
  }
});

test('a model reply with no content and no calls is not sent back as an empty assistant message', async () => {
  const requests = await run(
    'go',
    [
      { content: '', finishReason: 'stop', usage: ZERO_USAGE },
      { content: 'done', finishReason: 'stop', usage: ZERO_USAGE },
    ],
    (registry) => {
      const agent = registry.agents.get('probe')!;
      const sideA = { ...(agent.sideA as { prompt: string }), stopOnResponse: false, maxSteps: 3 };
      registry.agents.set('probe', { ...agent, sideA });
    },
  );

  assert.ok(requests.length >= 2, 'the empty reply did not end the side');
  for (const [index, request] of requests.entries()) {
    assert.ok(!request.messages.some(blank), `request ${index + 1} carries no empty assistant row`);
  }
});
