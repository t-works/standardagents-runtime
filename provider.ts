import { ProviderError, mapReasoningLevel } from '@standardagents/spec';
import type {
  LLMProviderInterface,
  ProviderErrorCode,
  ProviderFactory,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderToolCallPart,
  ProviderUsage,
} from '@standardagents/spec';
import { parseJson } from './util.ts';

type ReasoningStyle = 'openrouter' | 'deepseek' | 'openai' | 'none';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
  reasoningStyle?: ReasoningStyle;
  defaultHeaders?: Record<string, string>;
}

type Config = {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  defaultHeaders?: Record<string, string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const DONE = '[DONE]';

function textOf(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''))).join('') || null;
  }
  if (typeof content === 'object') {
    const error = content as { message?: unknown; error?: unknown };
    if (typeof error.message === 'string') return error.message;
    if (error.error !== undefined) return textOf(error.error);
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function toOpenAIContent(content: unknown): unknown {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  return (content as Array<Record<string, unknown>>).map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'image':
        return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}`, detail: part.detail } };
      case 'image_url':
        return { type: 'image_url', image_url: part.image_url };
      case 'file':
        return {
          type: 'file',
          file: {
            filename: part.filename ?? 'file',
            file_data: `data:${part.mediaType};base64,${part.data}`,
          },
        };
      default:
        return part;
    }
  });
}

/**
 * Accept both the specification's ProviderMessage shape (camelCase) and the
 * loose LLMMessage shape hooks produce (`tool_calls`, `tool_call_id`, ...).
 */
type LooseMessage = Record<string, unknown> & { role: string };

function callsOf(message: LooseMessage): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  const raw = message.toolCalls ?? message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const call = entry as Record<string, any>;
    const fn = call.function ?? {};
    return {
      id: String(call.id ?? ''),
      name: String(call.name ?? fn.name ?? ''),
      arguments:
        call.arguments && typeof call.arguments === 'object'
          ? (call.arguments as Record<string, unknown>)
          : parseJson<Record<string, unknown>>(typeof call.arguments === 'string' ? call.arguments : fn.arguments, {}),
    };
  });
}

function toOpenAIMessage(message: ProviderMessage, style: ReasoningStyle): Record<string, unknown> {
  const loose = message as unknown as LooseMessage;
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: toOpenAIContent(message.content) };
    case 'tool': {
      const content = message.content as unknown;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? textOf(content)
            : (content as { type?: string; error?: string; text?: string } | null)?.type === 'error'
              ? `Error: ${(content as { error?: string }).error ?? ''}`
              : (content as { type?: string; text?: string } | null)?.type === 'text'
                ? String((content as { text?: string }).text ?? '')
                : '';
      const toolCallId = (message as { toolCallId?: string }).toolCallId ?? (loose.tool_call_id as string | undefined);
      if (!toolCallId) throw new Error(`Tool message for '${String(loose.toolName ?? loose.name ?? '?')}' has no toolCallId`);
      return { role: 'tool', tool_call_id: toolCallId, content: text };
    }
    case 'assistant': {
      const calls = callsOf(loose);
      // An assistant tool-call message carries an empty string, not null: DeepSeek
      // rejects null here while OpenAI accepts both.
      const out: Record<string, unknown> = { role: 'assistant', content: message.content ?? (calls.length ? '' : null) };
      if (calls.length) {
        out.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      // DeepSeek returns reasoning_content but does not accept it back as input;
      // OpenRouter accepts `reasoning` / `reasoning_details` for continuity.
      if (style === 'openrouter') {
        const reasoning = message.reasoning ?? (loose.reasoning_content as string | undefined);
        if (reasoning) out.reasoning = reasoning;
        const details = message.reasoningDetails ?? (loose.reasoning_details as unknown[] | undefined);
        if (details?.length) out.reasoning_details = details;
      }
      return out;
    }
    default:
      return loose;
  }
}

function finishReasonOf(value: string | undefined | null): ProviderResponse['finishReason'] {
  switch (value) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function usageOf(raw: Record<string, any> | undefined): ProviderUsage {
  const usage = raw ?? {};
  const details = usage.completion_tokens_details ?? {};
  const promptDetails = usage.prompt_tokens_details ?? {};
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const out: ProviderUsage = {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
  };
  if (details.reasoning_tokens != null) out.reasoningTokens = Number(details.reasoning_tokens);
  if (promptDetails.cached_tokens != null) out.cachedTokens = Number(promptDetails.cached_tokens);
  if (usage.cost != null) out.cost = Number(usage.cost);
  return out;
}

function toolCallsOf(raw: Array<Record<string, any>> | undefined): ProviderToolCallPart[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((call, index) => ({
    id: String(call.id ?? `call_${index}`),
    name: String(call.function?.name ?? ''),
    arguments: parseJson<Record<string, unknown>>(call.function?.arguments, {}),
  }));
}

async function providerError(response: Response, providerName: string): Promise<ProviderError> {
  let detail = '';
  try {
    const raw = await response.text();
    detail = textOf(parseJson<Record<string, unknown>>(raw, {}).error) ?? raw;
  } catch {
    detail = response.statusText;
  }
  const code: ProviderErrorCode =
    response.status === 429
      ? 'rate_limit'
      : response.status === 401 || response.status === 403
        ? 'auth_error'
        : response.status === 408 || response.status === 504
          ? 'timeout'
          : response.status >= 500
            ? 'server_error'
            : response.status === 400 || response.status === 422
              ? 'invalid_request'
              : 'unknown';
  const retryAfter = Number(response.headers.get('retry-after') ?? '') || undefined;
  return new ProviderError(`${providerName} returned ${response.status}: ${detail.slice(0, 800)}`, code, response.status, retryAfter, {
    origin: `provider:${providerName}`,
    upstream: response.url || undefined,
  });
}

function createProvider(options: OpenAICompatibleOptions, config: Config): LLMProviderInterface {
  const style = options.reasoningStyle ?? 'none';
  const doFetch = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl || options.baseUrl).replace(/\/+$/, '');

  const bodyFor = (request: ProviderRequest, stream: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => toOpenAIMessage(message, style)),
    };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (request.tools?.length) body.tools = request.tools;
    if (request.toolChoice) {
      body.tool_choice =
        typeof request.toolChoice === 'string'
          ? request.toolChoice
          : { type: 'function', function: { name: request.toolChoice.name } };
    }
    if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls;
    if (request.maxOutputTokens != null) body.max_tokens = request.maxOutputTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (request.topK != null) body.top_k = request.topK;
    if (request.stopSequences?.length) body.stop = request.stopSequences;
    if (request.responseFormat?.type === 'json') body.response_format = { type: 'json_object' };
    if (request.user) body.user = request.user;

    if (request.reasoning?.level !== undefined) {
      const effort = mapReasoningLevel(request.reasoning.level, request.reasoning.levels);
      if (style === 'openrouter') {
        const reasoning: Record<string, unknown> = {};
        if (effort) reasoning.effort = effort;
        if (request.reasoning.maxTokens) reasoning.max_tokens = request.reasoning.maxTokens;
        if (request.reasoning.exclude) reasoning.exclude = true;
        if (Object.keys(reasoning).length) body.reasoning = reasoning;
      } else if (style === 'openai' && effort) {
        body.reasoning_effort = effort;
      }
    }
    Object.assign(body, request.providerOptions ?? {});
    return body;
  };

  const signalFor = (request: ProviderRequest): AbortSignal => {
    const timeout = config.timeout ?? 120_000;
    const timer = AbortSignal.timeout(timeout);
    return request.signal ? AbortSignal.any([request.signal, timer]) : timer;
  };

  const send = async (request: ProviderRequest, stream: boolean): Promise<Response> => {
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...options.defaultHeaders,
        ...config.defaultHeaders,
      },
      body: JSON.stringify(bodyFor(request, stream)),
      signal: signalFor(request),
    });
    if (!response.ok) throw await providerError(response, options.name);
    return response;
  };

  return {
    name: options.name,
    specificationVersion: '1',

    supportsModel: () => true,

    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const response = await send(request, false);
      const data = (await response.json()) as Record<string, any>;
      const choice = data.choices?.[0] ?? {};
      const message = choice.message ?? {};
      const toolCalls = toolCallsOf(message.tool_calls);
      const result: ProviderResponse = {
        content: textOf(message.content),
        reasoning: message.reasoning_content ?? message.reasoning ?? null,
        reasoningDetails: message.reasoning_details ?? undefined,
        toolCalls,
        finishReason: finishReasonOf(choice.finish_reason),
        usage: usageOf(data.usage),
        metadata: {
          model: data.model ?? request.model,
          provider: data.provider ?? options.name,
          requestId: data.id ?? response.headers.get('x-request-id') ?? undefined,
        },
      };
      return result;
    },

    async stream(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamChunk>> {
      const response = await send(request, true);
      const decoder = new TextDecoder();
      const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
      if (!reader) throw new ProviderError(`${options.name} returned no response body`, 'server_error', 500, undefined, { origin: `provider:${options.name}` });

      // Assemble streamed tool calls across deltas; emit them when the stream ends.
      const pending = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason: ProviderResponse['finishReason'] = 'stop';
      let usage: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      async function* iterate(): AsyncGenerator<ProviderStreamChunk> {
        let buffer = '';
        try {
          while (true) {
            const { value, done } = await reader!.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === DONE) continue;
              const event = parseJson<Record<string, any>>(payload, {});
              if (event.usage) usage = usageOf(event.usage);
              const choice = event.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = finishReasonOf(choice.finish_reason);
              const delta = choice.delta ?? {};
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                yield { type: 'reasoning-delta', delta: delta.reasoning_content };
              }
              if (typeof delta.reasoning === 'string' && delta.reasoning) {
                yield { type: 'reasoning-delta', delta: delta.reasoning };
              }
              if (typeof delta.content === 'string' && delta.content) {
                yield { type: 'content-delta', delta: delta.content };
              }
              for (const call of delta.tool_calls ?? []) {
                const index = Number(call.index ?? 0);
                const known = pending.get(index);
                if (!known && (call.id || call.function?.name)) {
                  const entry = { id: String(call.id ?? `call_${index}`), name: String(call.function?.name ?? ''), arguments: '' };
                  pending.set(index, entry);
                  yield { type: 'tool-call-start', id: entry.id, name: entry.name };
                }
                const id = pending.get(index)?.id ?? String(call.id ?? `call_${index}`);
                if (call.function?.arguments) {
                  const delta = String(call.function.arguments);
                  const entry = pending.get(index);
                  if (entry) entry.arguments += delta;
                  yield { type: 'tool-call-delta', id, argumentsDelta: delta };
                }
              }
            }
          }
          for (const entry of pending.values()) {
            yield { type: 'tool-call-done', id: entry.id, arguments: parseJson<Record<string, unknown>>(entry.arguments, {}) };
          }
          yield { type: 'finish', finishReason, usage };
        } finally {
          await reader!.cancel().catch(() => {});
        }
      }

      return iterate();
    },
  };
}

/** Build an OpenAI-compatible provider factory with typed config slots. */
export function openaiCompatible(options: OpenAICompatibleOptions): ProviderFactory {
  const factory = ((config: Config) => createProvider(options, config)) as ProviderFactory;
  factory.configSlots = {
    apiKey: {
      type: 'secret',
      required: true,
      defaultEnv: options.apiKeyEnv,
      overridable: true,
      description: `${options.name} API key`,
    },
    baseUrl: {
      type: 'url',
      required: false,
      default: options.baseUrl,
      defaultEnv: options.baseUrlEnv,
      overridable: true,
      description: `${options.name} API base URL`,
    },
    timeout: {
      type: 'number',
      required: false,
      default: 120000,
      overridable: true,
      description: 'Provider request timeout in milliseconds',
    },
  };
  return factory;
}

export const openrouter = openaiCompatible({
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  baseUrlEnv: 'OPENROUTER_BASE_URL',
  reasoningStyle: 'openrouter',
  defaultHeaders: {
    'HTTP-Referer': 'https://standardagentspec.org',
    'X-Title': 'standard-agent-runner',
  },
});

export const deepseek = openaiCompatible({
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  reasoningStyle: 'deepseek',
});
