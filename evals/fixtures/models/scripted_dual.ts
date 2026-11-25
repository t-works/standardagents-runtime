import { defineModel } from '@standardagents/spec';
import type { ProviderInstance, ProviderRequest, ProviderStreamChunk } from '@standardagents/spec';
import scripted from './scripted.ts';

/**
 * `scripted` plus a record of what each side was actually shown: one
 * `model.views` entry per call, `{ side, messages: [{ role, content, toolCalls }] }`.
 * The messages are the provider request rows, so the perspective mapping is
 * visible directly: own turns are `assistant`, the other side is `user`.
 *
 * A separate model so the other cases' request logs stay unchanged.
 */
export default defineModel({
  name: 'scripted_dual',
  model: 'scripted_dual',
  provider: (config, context) => {
    const base = scripted.provider(config, context) as ProviderInstance;
    const state = context?.state as NonNullable<typeof context>['state'] & { activeSide?: 'a' | 'b' | null };

    const generate = async (request: ProviderRequest) => {
      if (state) {
        const log = (await state.getValue<Array<Record<string, unknown>>>('model.views')) ?? [];
        log.push({
          side: state.activeSide ?? null,
          messages: request.messages.map((entry) => {
            const row = entry as { role: string; content?: unknown; toolCalls?: Array<{ name: string }> };
            return {
              role: row.role,
              content: typeof row.content === 'string' ? row.content : null,
              toolCalls: (row.toolCalls ?? []).map((call) => call.name),
            };
          }),
        });
        await state.setValue('model.views', log);
      }
      return base.generate(request);
    };

    return {
      ...base,
      name: 'scripted_dual',
      generate,
      async stream(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamChunk>> {
        const response = await generate(request);
        return (async function* () {
          if (response.content) yield { type: 'content-delta', delta: response.content } as ProviderStreamChunk;
          yield { type: 'content-done' } as ProviderStreamChunk;
        })();
      },
    };
  },
});
