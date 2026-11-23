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

/**
 * `threadId` names the thread the event reports on, so one sink can serve several
 * live threads: the thread whose message/status/tool/effect it is, or — for
 * `subagent` events — the parent whose `children[]` entry changed (`reference`
 * still names the child).
 */
export type RuntimeEvent =
  | { type: 'message'; threadId: string; message: Message }
  | { type: 'message_updated'; threadId: string; message: Message }
  | { type: 'tool_started'; threadId: string; name: string; progress?: string }
  | { type: 'tool_done'; threadId: string; name: string; status: 'success' | 'error'; error?: string }
  | { type: 'status'; threadId: string; status: ThreadStatus }
  | { type: 'event'; threadId: string; event: string; data: unknown }
  | { type: 'subagent'; threadId: string; reference: string; relationship: string; name: string; status: string }
  | { type: 'effect'; threadId: string; id: string; name: string }
  | { type: 'error'; threadId: string; message: string }
  | { type: 'log'; threadId: string; level: 'info' | 'warn' | 'error'; message: string };

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
  log(level: 'info' | 'warn' | 'error', message: string, threadId: string): void;
  instanceEnv(name: string): string | undefined;
}
