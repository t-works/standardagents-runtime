import type {
  DecisionProviderFactory,
  DecisionProviderInterface,
  Message,
  ScheduledEffect,
  ThreadStatus,
  ToolResult,
} from '@standardagents/spec';
import type { Registry } from './loader.ts';
import type { ThreadRecord, ThreadStore } from './store.ts';
import type { Thread } from './thread.ts';

export type RuntimeEvent =
  | { type: 'message'; message: Message }
  | { type: 'message_updated'; message: Message }
  | { type: 'tool_started'; name: string; progress?: string }
  | { type: 'tool_done'; name: string; status: 'success' | 'error'; error?: string }
  | { type: 'status'; status: ThreadStatus }
  | { type: 'event'; event: string; data: unknown }
  | { type: 'subagent'; reference: string; relationship: string; name: string; status: string }
  | { type: 'effect'; id: string; name: string }
  | { type: 'error'; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface SessionStopOptions {
  result?: string;
  notifyParent?: string;
  status?: string;
}

/** The surface a Thread needs from the runtime that owns it. */
export interface RuntimeLike {
  store: ThreadStore;
  registry: Registry;
  /** Start (or join) an execution. Resolves when this thread settles. */
  start(thread: Thread, triggerSide?: 'a' | 'b'): Promise<void>;
  invokeTool(thread: Thread, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  queueTool(thread: Thread, name: string, args: Record<string, unknown>): void;
  requestSessionStop(thread: Thread, options: SessionStopOptions): void;
  requestTerminate(thread: Thread): void;
  scheduleEffect(thread: Thread, effectId: string): void;
  /** Build a decision provider for one call; independent of execution and not cached. */
  decisionProvider(thread: Thread, factory: DecisionProviderFactory): Promise<DecisionProviderInterface>;
  /** User-facing `state.emit` channel (thread events). */
  emit(thread: Thread, event: string, data: unknown): void;
  /** Internal runtime events: messages, status transitions, effects. */
  notify(event: RuntimeEvent): void;
  /** One live Thread instance per thread id, shared by every runtime surface. */
  threadFor(record: ThreadRecord): Thread;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  instanceEnv(name: string): string | undefined;
}
