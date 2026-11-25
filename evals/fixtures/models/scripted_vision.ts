import { defineModel } from '@standardagents/spec';
import type { ProviderInstance, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '@standardagents/spec';

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Vision-capable stand-in. Declares image support so the runtime keeps image
 * attachments as a multimodal part, and records the raw content of the newest
 * user message under `model.requestLog` so a case can read it with `parts`.
 *
 * Separate from `scripted.ts` to keep the other cases' request logs unchanged.
 */
export default defineModel({
  name: 'scripted_vision',
  model: 'scripted_vision',
  capabilities: { supportsImages: true },
  provider: (_config, context) => {
    const state = context?.state;

    const generate = async (request: ProviderRequest): Promise<ProviderResponse> => {
      if (state) {
        const log = (await state.getValue<Array<Record<string, unknown>>>('model.requestLog')) ?? [];
        const newest = [...request.messages].reverse().find((message) => (message as { role?: string }).role === 'user');
        log.push({ parts: (newest as { content?: unknown } | undefined)?.content ?? null });
        await state.setValue('model.requestLog', log);
        await state.setValue('model.calls', log.length);
      }
      return { content: 'vision-ok', finishReason: 'stop', usage: ZERO_USAGE };
    };

    const instance: ProviderInstance = {
      name: 'scripted_vision',
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
