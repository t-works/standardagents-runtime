import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Timestamps are microseconds since epoch, per the specification. */
export const nowUs = (): number => Date.now() * 1000;
export const newId = (): string => randomUUID();

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (tmp + rename) so a crash never leaves half a store. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : asText((part as { text?: unknown })?.text)))
      .join('');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mask env values classified `secret` (Threads §2.3: redacted from tool output and
 * logs). Longest-first so a secret containing another secret is not half-masked.
 * The whole value is replaced: a partial reveal would leak most of a short token.
 *
 * shortcut: raw substring matching only, so a JSON-escaped or encoded copy of a
 * secret survives; upgrade to structural redaction if secrets grow quotes/newlines.
 */
export function redactEnvValues(
  env: Record<string, string>,
  envTypes: Record<string, 'text' | 'secret'>,
  text: string,
): string {
  let out = text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => (envTypes[name] ?? 'secret') === 'secret' && value)
    .sort(([a], [b]) => env[b].length - env[a].length);
  for (const [name, value] of secrets) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
}
