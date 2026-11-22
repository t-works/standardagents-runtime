import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseQualifiedName, validateAgentDefinition } from '@standardagents/spec';
import type {
  AgentDefinition,
  DefinitionIssue,
  EffectDefinition,
  HandlerDefinition,
  HookDefinitionResult,
  HookName,
  ModelDefinition,
  PromptDefinition,
  ThreadState,
  ToolDefinition,
} from '@standardagents/spec';

/**
 * A loaded hook as the runner drives it: hooks are dispatched by name, so the
 * payload and return type depend on `hook` and are narrowed at each call site.
 */
export interface AnyHook extends HookDefinitionResult<HookName> {
  execute: (state: ThreadState, ...payload: any[]) => Promise<any>;
}

export interface Registry {
  agents: Map<string, AgentDefinition>;
  prompts: Map<string, PromptDefinition>;
  tools: Map<string, ToolDefinition>;
  models: Map<string, ModelDefinition>;
  hooks: Map<string, AnyHook>;
  handlers: Map<string, HandlerDefinition>;
  effects: Map<string, EffectDefinition>;
  /** Absolute paths of definition files, for error messages. */
  sources: Record<string, string>;
}

const CATEGORIES = ['agents', 'prompts', 'tools', 'models', 'hooks', 'handlers', 'effects'] as const;
type Category = (typeof CATEGORIES)[number];

const EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']);

/** Hook names that run in user scope; `ThreadHookName` excludes exactly these. */
const USER_SCOPE_HOOKS = new Set<HookName>(['user_client_attached', 'user_client_detached', 'user_value_changed']);

const emptyRegistry = (): Registry => ({
  agents: new Map(),
  prompts: new Map(),
  tools: new Map(),
  models: new Map(),
  hooks: new Map(),
  handlers: new Map(),
  effects: new Map(),
  sources: {},
});

/** Strip a package qualifier: `@scope/pkg/agent` and `pkg/agent` both yield `agent`. */
export function unqualify(name: string): string {
  return parseQualifiedName(name)[1];
}

function definitionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => !file.startsWith('.') && !file.startsWith('_'))
    .filter((file) => EXTENSIONS.has(path.extname(file)))
    .map((file) => path.join(dir, file))
    .sort();
}

function findLayoutBase(root: string): string | null {
  for (const candidate of [root, path.join(root, 'agents')]) {
    if (existsSync(path.join(candidate, 'agents')) && existsSync(path.join(candidate, 'prompts'))) {
      return candidate;
    }
  }
  return null;
}

function put<T>(registry: Registry, category: Category, name: string, value: T, source: string, issues: DefinitionIssue[]): void {
  const map = registry[category] as unknown as Map<string, T>;
  const key = unqualify(name);
  if (!key) {
    issues.push({ code: 'agent_name_missing', severity: 'error', message: `${category} definition has no name (${source})`, path: category });
    return;
  }
  if (map.has(key)) {
    issues.push({
      code: 'subagent_relationship_duplicate',
      severity: 'error',
      message: `Duplicate ${category} name '${key}' in ${source} and ${registry.sources[`${category}:${key}`] ?? 'another file'}`,
      path: category,
    });
    return;
  }
  map.set(key, value);
  registry.sources[`${category}:${key}`] = source;
}

/**
 * Load a Standard Agent from a directory in the conventional layout, or from a
 * packed npm package (`agents/`, `prompts/`, ... exports plus `__meta`).
 */
export async function loadSource(source: string): Promise<{ registry: Registry; issues: DefinitionIssue[]; id: string }> {
  const registry = emptyRegistry();
  const issues: DefinitionIssue[] = [];
  const absolute = path.resolve(source);
  const isDir = existsSync(absolute);

  if (isDir) {
    const base = findLayoutBase(absolute);
    if (!base) {
      throw new Error(
        `No Standard Agent layout under ${absolute}: expected an 'agents/' folder (agents, prompts, tools, models, hooks, handlers, effects).`,
      );
    }
    for (const category of CATEGORIES) {
      for (const file of definitionFiles(path.join(base, category))) {
        const module = await import(pathToFileURL(file).href);
        const definition = module.default;
        if (definition === undefined) {
          throw new Error(`${file} has no default export`);
        }
        const fallback = path.basename(file, path.extname(file));
        switch (category) {
          case 'agents':
            put(registry, 'agents', definition.name ?? fallback, definition, file, issues);
            break;
          case 'prompts':
            put(registry, 'prompts', definition.name ?? fallback, definition, file, issues);
            break;
          case 'models':
            put(registry, 'models', definition.name ?? fallback, definition, file, issues);
            break;
          case 'tools':
            put(registry, 'tools', fallback, definition, file, issues);
            break;
          case 'handlers':
            put(registry, 'handlers', fallback, definition, file, issues);
            break;
          case 'hooks':
            put(registry, 'hooks', definition.id ?? fallback, definition, file, issues);
            break;
          case 'effects':
            put(registry, 'effects', fallback, definition, file, issues);
            break;
        }
      }
    }
    return { registry, issues: [...issues, ...validateRegistry(registry)], id: absolute };
  }

  // Packed package: resolve from the caller's project, then read its registries.
  const require = createRequire(path.join(process.cwd(), '__standard_agent_runner__.js'));
  let resolved: string;
  try {
    resolved = require.resolve(source);
  } catch {
    throw new Error(`Cannot find '${source}' as a directory or an installed package from ${process.cwd()}`);
  }
  const module = await import(pathToFileURL(resolved).href);
  if (!module.__meta) {
    throw new Error(`${source} is not a packed Standard Agent package (no __meta export)`);
  }
  for (const category of CATEGORIES) {
    const loaders = module[category];
    if (!loaders) continue;
    for (const [name, load] of Object.entries(loaders as Record<string, () => Promise<unknown>>)) {
      const definition = await load();
      put(registry, category, name, definition, `${source}/${category}/${name}`, issues);
    }
  }
  return { registry, issues: [...issues, ...validateRegistry(registry)], id: String(module.__meta.packageId ?? source) };
}

/** Reference checks that go beyond the spec's per-agent validator. */
export function validateRegistry(registry: Registry): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const error = (message: string, issuePath: string): void => {
    issues.push({ code: 'agent_side_invalid', severity: 'error', message, path: issuePath });
  };

  for (const [name, agent] of registry.agents) {
    issues.push(...validateAgentDefinition(agent));
    for (const sideKey of ['sideA', 'sideB'] as const) {
      const side = agent[sideKey];
      if (!side) continue;
      if (side.prompt && !registry.prompts.has(unqualify(side.prompt))) {
        error(`Agent '${name}' ${sideKey} references undefined prompt '${side.prompt}'`, `${name}.${sideKey}.prompt`);
      }
      if (side.handler && !registry.handlers.has(unqualify(side.handler))) {
        error(`Agent '${name}' ${sideKey} references undefined handler '${side.handler}'`, `${name}.${sideKey}.handler`);
      }
      for (const [index, relationship] of (side.subagents ?? []).entries()) {
        const target = unqualify(relationship.agent);
        const child = registry.agents.get(target);
        if (!child) {
          error(`Agent '${name}' ${sideKey} references undefined subagent '${relationship.agent}'`, `${name}.${sideKey}.subagents[${index}].agent`);
          continue;
        }
        for (const requirement of child.parentHooks ?? []) {
          const hook = registry.hooks.get(requirement.hook);
          if (!hook) {
            error(
              `Required parent hook '${requirement.hook}' from child '${target}' is not available; composition fails closed`,
              `${name}.${sideKey}.subagents[${index}]`,
            );
          } else if (USER_SCOPE_HOOKS.has(hook.hook)) {
            error(
              `Required parent hook '${requirement.hook}' from child '${target}' is user-scoped and cannot compose onto a parent; composition fails closed`,
              `${name}.${sideKey}.subagents[${index}]`,
            );
          }
        }
      }
    }
    for (const hookId of agent.hooks ?? []) {
      if (!registry.hooks.has(hookId)) error(`Agent '${name}' references undefined hook '${hookId}'`, `${name}.hooks`);
    }
  }

  for (const [name, prompt] of registry.prompts) {
    if (!registry.models.has(unqualify(prompt.model))) {
      error(`Prompt '${name}' references undefined model '${prompt.model}'`, `${name}.model`);
    }
    for (const hookId of prompt.hooks ?? []) {
      if (!registry.hooks.has(hookId)) error(`Prompt '${name}' references undefined hook '${hookId}'`, `${name}.hooks`);
    }
    for (const [index, entry] of (prompt.tools ?? []).entries()) {
      const ref = typeof entry === 'string' ? entry : entry.name;
      if (ref === 'subagents' || ref === 'subagent_create' || ref === 'subagent_message') continue;
      const target = unqualify(ref);
      if (!registry.tools.has(target) && !registry.prompts.has(target) && !registry.agents.has(target)) {
        error(`Prompt '${name}' tool '${ref}' is not a defined tool, prompt, or agent`, `${name}.tools[${index}]`);
      }
    }
  }

  for (const [name, model] of registry.models) {
    for (const fallback of model.fallbacks ?? []) {
      if (!registry.models.has(unqualify(fallback))) error(`Model '${name}' fallback '${fallback}' is undefined`, `${name}.fallbacks`);
    }
    if (typeof model.provider !== 'function') error(`Model '${name}' has no provider factory`, `${name}.provider`);
  }

  return issues;
}

export function hasErrors(issues: DefinitionIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function formatIssues(issues: DefinitionIssue[]): string {
  return issues.map((issue) => `  ${issue.severity} ${issue.code} at ${issue.path || '<root>'}: ${issue.message}`).join('\n');
}
