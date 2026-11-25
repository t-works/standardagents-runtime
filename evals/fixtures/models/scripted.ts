import { defineModel } from '@standardagents/spec';
import type { ProviderInstance, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '@standardagents/spec';

/**
 * Deterministic stand-in model. Directives in the newest user message become
 * tool calls: [[tool:name {"arg":1}]]. [[once]] makes them play on turn 1 only;
 * without it they replay every turn (for maxSteps / maxSessionTurns probes).
 */
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = part as { text?: string; content?: string };
      return record.text ?? record.content ?? '';
    })
    .join('');
}

function newestUser(request: ProviderRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index] as { role?: string; content?: unknown };
    if (message.role === 'user') return textOf(message.content);
  }
  return '';
}

function systemText(request: ProviderRequest): string {
  const message = request.messages.find((entry) => (entry as { role?: string }).role === 'system');
  return message ? textOf((message as { content?: unknown }).content) : '';
}

/** Read a balanced {...} object, ignoring braces inside JSON strings. */
function readObject(text: string, start: number): { body: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function parseDirectives(user: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const marker = '[[tool:';
  let cursor = 0;
  while (true) {
    const open = user.indexOf(marker, cursor);
    if (open === -1) break;
    let index = open + marker.length;
    let name = '';
    while (index < user.length && !/[\s\]]/.test(user[index])) name += user[index++];
    while (index < user.length && /\s/.test(user[index])) index++;
    let args: Record<string, unknown> = {};
    if (user[index] === '{') {
      const object = readObject(user, index);
      if (object) {
        try {
          args = JSON.parse(object.body) as Record<string, unknown>;
        } catch {
          args = {};
        }
        index = object.end;
      }
    }
    const close = user.indexOf(']]', index);
    if (name) calls.push({ name, arguments: args });
    cursor = close === -1 ? user.length : close + 2;
  }
  return calls;
}

export default defineModel({
  name: 'scripted',
  model: 'scripted',
  provider: (_config, context) => {
    const state = context?.state;
    let served = 0;

    const generate = async (request: ProviderRequest): Promise<ProviderResponse> => {
      served += 1;
      const user = newestUser(request);
      if (state) {
        const log = (await state.getValue<Array<Record<string, unknown>>>('model.requestLog')) ?? [];
        log.push({
          system: systemText(request),
          user,
          users: request.messages
            .filter((entry) => (entry as { role?: string }).role === 'user')
            .map((entry) => textOf((entry as { content?: unknown }).content)),
          roles: request.messages.map((entry) => (entry as { role?: string }).role ?? 'user'),
          toolDetail: JSON.stringify(request.tools ?? []),
          tools: (request.tools ?? []).map((tool) => {
            const entry = tool as { name?: string; function?: { name?: string } };
            return entry.name ?? entry.function?.name ?? '';
          }),
        });
        await state.setValue('model.requestLog', log);
        await state.setValue('model.calls', log.length);
      }

      const once = user.includes('[[once]]');
      // shortcut: the counter key is derived from message text; long messages that share a prefix collide.
      const seenKey = 'model.served:' + user.length + ':' + user.slice(0, 40);
      const servedBefore = state ? ((await state.getValue<number>(seenKey)) ?? 0) : 0;
      if (state) await state.setValue(seenKey, servedBefore + 1);

      const directives = parseDirectives(user);
      const calls = once && servedBefore > 0 ? [] : directives;
      if (calls.length === 0) {
        return { content: 'scripted-ok', finishReason: 'stop', usage: ZERO_USAGE };
      }
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: calls.map((call, index) => ({
          id: 'call_' + served + '_' + index,
          name: call.name,
          arguments: call.arguments,
        })),
        usage: ZERO_USAGE,
      };
    };

    const instance: ProviderInstance = {
      name: 'scripted',
      specificationVersion: '1',
      generate,
      async stream(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamChunk>> {
        const response = await generate(request);
        return (async function* () {
          if (response.content) yield { type: 'content-delta', delta: response.content } as ProviderStreamChunk;
          yield { type: 'content-done' } as ProviderStreamChunk;
        })();
      },
    };
    return instance;
  },
});
