import type { AgentDefinition, HookExecutionContext, SubagentRelationship } from '@standardagents/spec';
import type { AnyHook, Registry } from './loader.ts';
import { unqualify } from './loader.ts';

export interface ResolvedHook {
  hook: AnyHook;
  context: HookExecutionContext;
}

export type FlagResolver = (flag: string) => string | undefined;

/** A relationship is enabled unless it declares an `optional` env flag. */
export function relationshipEnabled(relationship: SubagentRelationship, flag: FlagResolver): boolean {
  if (!relationship.optional) return true;
  const value = flag(relationship.optional);
  return value !== undefined && ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

interface ChildHook {
  relationship: SubagentRelationship;
  agent: AgentDefinition;
}

/**
 * Resolve the hook set for one position (Hooks §1.3):
 * child `before_parent` hooks, the prompt's (or agent's) base set, then child
 * `after_parent` hooks — each in side A then side B relationship order, then
 * declaration order.
 */
export function resolveHooks(
  registry: Registry,
  agent: AgentDefinition,
  activePrompt: string | null,
  hookName: string,
  flag: FlagResolver = (name) => process.env[name],
): ResolvedHook[] {
  const children: ChildHook[] = [];
  for (const side of [agent.sideA, agent.sideB]) {
    for (const relationship of side?.subagents ?? []) {
      if (!relationshipEnabled(relationship, flag)) continue;
      const child = registry.agents.get(unqualify(relationship.agent));
      if (child) children.push({ relationship, agent: child });
    }
  }

  const childHooks = (stage: 'before_parent' | 'after_parent'): ResolvedHook[] => {
    const out: ResolvedHook[] = [];
    for (const { relationship, agent: child } of children) {
      for (const requirement of child.parentHooks ?? []) {
        if ((requirement.stage ?? 'after_parent') !== stage) continue;
        const hook = registry.hooks.get(requirement.hook);
        if (!hook || hook.hook !== hookName) continue;
        out.push({
          hook,
          context: {
            source: {
              kind: 'child',
              relationshipName: relationship.as ?? unqualify(relationship.agent),
              agentName: child.name,
            },
          },
        });
      }
    }
    return out;
  };

  const prompt = activePrompt ? registry.prompts.get(unqualify(activePrompt)) : null;
  const baseIds = prompt?.hooks?.length ? prompt.hooks : (agent.hooks ?? []);
  const base: ResolvedHook[] = [];
  for (const id of baseIds) {
    const hook = registry.hooks.get(unqualify(id));
    if (!hook || hook.hook !== hookName) continue;
    base.push({
      hook,
      context: {
        source: prompt ? { kind: 'prompt', promptName: prompt.name } : { kind: 'agent', agentName: agent.name },
      },
    });
  }

  return [...childHooks('before_parent'), ...base, ...childHooks('after_parent')];
}
