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

async function run(
  request: string,
  script: ProviderResponse[],
  tweak: (registry: Awaited<ReturnType<typeof loadSource>>['registry']) => void,
): Promise<ProviderRequest[]> {
  const root = mkdtempSync(path.join(tmpdir(), 'sa-context-'));
  try {
    const { registry } = await loadSource(FIXTURES);
    const { requests, provider } = scripted(script);
    registry.models.set('scripted', { ...registry.models.get('scripted')!, provider });
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

/**
 * A thinking provider rejects an assistant turn with no text, no calls and no
 * reasoning once tools are declared (deepseek: "The `reasoning_content` in the
 * thinking mode must be passed back to the API"). Two ways in: the calls were
 * trimmed by `includePastTools`, or the model answered empty.
 */
test('a turn whose calls were trimmed from the history is not sent as an empty assistant message', async () => {
  const requests = await run(
    'go',
    [
      {
        content: null,
        // A thinking model's tool call carries reasoning; the provider may drop it on
        // the way out, so reasoning must not keep the otherwise empty row alive.
        reasoning: 'I should call record with the value one.',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_1', name: 'record', arguments: { value: 'one' } }],
        usage: ZERO_USAGE,
      },
      { content: 'done', finishReason: 'stop', usage: ZERO_USAGE },
    ],
    (registry) => {
      const prompt = registry.prompts.get('probe_prompt')!;
      registry.prompts.set('probe_prompt', { ...prompt, includePastTools: false });
    },
  );

  assert.equal(requests.length, 2, 'the run took a second step');
  assert.deepEqual(
    requests[1].messages.map((row) => row.role),
    ['system', 'user'],
    'the trimmed call leaves nothing behind: no empty assistant row, and no tool row either',
  );
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
