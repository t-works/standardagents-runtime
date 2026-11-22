#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import type { AgentDefinition, Message } from '@standardagents/spec';
import type { RuntimeEvent } from './contract.ts';
import { formatIssues, hasErrors, loadSource, unqualify, type Registry } from './loader.ts';
import { Runtime } from './runtime.ts';
import { ThreadStore } from './store.ts';
import { Thread, triggerSideFor } from './thread.ts';
import { truncate } from './util.ts';

interface Options {
  _: string[];
  agent?: string;
  message?: string;
  interactive?: boolean;
  thread?: string;
  store?: string;
  json?: boolean;
  maxSteps?: number;
  help?: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { command: string | undefined; options: Options } {
  const options: Options = { _: [] };
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const rest = command ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--agent':
      case '-a':
        options.agent = rest[++i];
        break;
      case '--message':
      case '-m':
        options.message = rest[++i];
        break;
      case '--interactive':
      case '-i':
        options.interactive = true;
        break;
      case '--thread':
      case '-t':
        options.thread = rest[++i];
        break;
      case '--store':
        options.store = rest[++i];
        break;
      case '--json':
        options.json = true;
        break;
      case '--max-steps':
        options.maxSteps = Number(rest[++i]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        options._.push(arg);
    }
  }
  return { command, options };
}

function usage(): void {
  console.log(`standard-agent — run Standard Agents (specification 0.2.0)

Usage:
  standard-agent run <directory|package> [options]
  standard-agent list <directory|package>
  standard-agent threads [--store <dir>]

Run options:
  -a, --agent <name>     Agent to run (needed when the source has several)
  -m, --message <text>   Send one message, run to idle, exit
  -i, --interactive      Chat over stdin (default when stdin is a terminal)
  -t, --thread <id>      Resume an existing thread
      --store <dir>      Thread store (default .standard-agent)
      --max-steps <n>    Per-turn model step cap (default 12)
      --json             Emit JSONL runtime events

Examples:
  standard-agent run ./my-agent -a assistant -m "What is idempotent?"
  standard-agent run ./my-agent -i
  standard-agent threads`);
}

function pickAgent(name: string | undefined, registry: Registry): AgentDefinition {
  if (name) {
    const agent = registry.agents.get(unqualify(name));
    if (!agent) {
      fail(`Unknown agent '${name}'. Available: ${[...registry.agents.keys()].join(', ') || 'none'}`);
    }
    return agent;
  }
  const primary = [...registry.agents.values()].filter((agent) => agent.primary !== false);
  if (primary.length === 1) return primary[0];
  if (!primary.length) fail('This source declares no primary agent. Pass --agent <name>.');
  fail(`Several agents to choose from. Pass --agent: ${primary.map((agent) => agent.name).join(', ')}`);
}

function humanSideOf(agent: AgentDefinition): 'a' | 'b' | null {
  if (agent.sideA.human) return 'a';
  if (agent.sideB?.human) return 'b';
  return null;
}

function sideLabel(agent: AgentDefinition, side: 'a' | 'b'): string {
  const config = side === 'a' ? agent.sideA : agent.sideB;
  if (!config) return side === 'a' ? 'A' : 'B';
  if (config.human) return 'you';
  return config.label ?? ('prompt' in config ? config.prompt : config.handler) ?? side;
}

function printMessage(thread: Thread, message: Message): void {
  if (message.silent) return;
  const agent = thread.agent;
  if (message.role === 'tool') {
    console.log(`  ↳ ${message.name ?? 'tool'}${message.tool_status === 'error' ? ' failed' : ''}: ${truncate(message.content ?? '', 400)}`);
    return;
  }
  if (!message.content) return;
  // Messages a prompt produced carry its name; external input belongs to no side.
  const side = (message.metadata?.side as 'a' | 'b' | undefined) ?? (message.prompt ? (message.role === 'assistant' ? 'a' : 'b') : null);
  console.log(`${side ? sideLabel(agent, side) : 'you'}> ${message.content}`);
}

async function runCommand(options: Options): Promise<void> {
  const source = options._[0];
  if (!source) fail('Usage: standard-agent run <directory|package> [options]');
  const { registry, issues } = await loadSource(source);
  for (const issue of issues.filter((entry) => entry.severity === 'warning')) {
    console.warn(`warning ${issue.code}: ${issue.message}`);
  }
  if (hasErrors(issues)) fail(`Invalid Standard Agent source '${source}':\n${formatIssues(issues)}`);
  const store = new ThreadStore(path.resolve(options.store ?? '.standard-agent'));
  store.recoverStale();

  let printedUpTo = 0;
  const events = (event: RuntimeEvent): void => {
    if (options.json) {
      console.log(JSON.stringify(event));
      return;
    }
    switch (event.type) {
      case 'tool_started':
        console.log(`  · ${event.name}${event.progress ? `: ${event.progress}` : ''}`);
        break;
      case 'tool_done':
        if (event.status === 'error') console.log(`  · ${event.name} failed: ${event.error}`);
        break;
      case 'error':
        console.error(`! ${event.message}`);
        break;
      case 'log':
        if (event.level !== 'info') console.error(`${event.level}: ${event.message}`);
        break;
      case 'event':
        console.log(`  ~ ${event.event} ${JSON.stringify(event.data)}`);
        break;
      case 'effect':
        console.log(`  ~ effect ${event.name} ran`);
        break;
      default:
        break;
    }
  };
  const runtime = new Runtime({ store, registry, maxSteps: options.maxSteps, onEvent: events });

  let thread: Thread;
  if (options.thread) {
    const record = store.load(options.thread);
    if (!record) fail(`No thread '${options.thread}' in ${store.root}`);
    thread = runtime.threadFor(record);
    printedUpTo = thread.messages.length;
    if (!options.json) console.log(`Resuming thread ${thread.threadId} (${thread.agentId})`);
  } else {
    const agent = pickAgent(options.agent, registry);
    thread = await runtime.createThread({ agentId: agent.name });
    if (!options.json) console.log(`Thread ${thread.threadId} · agent ${thread.agentId}`);
  }

  await runtime.drainDueEffects(thread);
  await runtime.settle();

  const printNew = (): void => {
    if (!options.json) {
      for (const message of thread.messages.slice(printedUpTo)) printMessage(thread, message);
    }
    printedUpTo = thread.messages.length;
  };
  printNew();

  const send = async (text: string): Promise<void> => {
    const currentAgent = thread.agent;
    const humanSide = humanSideOf(currentAgent);
    const role = humanSide === 'a' ? 'assistant' : 'user';
    await thread.queueMessage({ role, content: text }, { trigger: false });
    await runtime.start(thread, triggerSideFor(role));
    await runtime.settle();
    printNew();
  };

  if (options.message !== undefined) {
    await send(options.message);
  } else if (!options.interactive && !stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) fail('No message supplied on stdin.');
    await send(text);
  } else {
    const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    const promptLabel = (): string => {
      const agentNow = thread.agent;
      const humanSide = humanSideOf(agentNow);
      return humanSide ? sideLabel(agentNow, humanSide) : 'input';
    };
    // A line iterator (not rl.question) so piped stdin does not drop buffered lines.
    try {
      stdout.write(`${promptLabel()}> `);
      for await (const line of rl) {
        const text = line.trim();
        if (text === '/exit' || text === '/quit') break;
        if (text) {
          try {
            await send(text);
          } catch (error) {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        stdout.write(`${promptLabel()}> `);
      }
      stdout.write('\n');
    } finally {
      rl.close();
    }
  }

  const pending = await thread.getScheduledEffects();
  if (pending.length && !options.json) {
    console.log(`${pending.length} scheduled effect(s) remain; they run on a later invocation.`);
  }
  if (!options.json) console.log(`thread ${thread.threadId}`);
}

async function listCommand(options: Options): Promise<void> {
  const source = options._[0];
  if (!source) fail('Usage: standard-agent list <directory|package>');
  const { registry, issues } = await loadSource(source);
  for (const issue of issues) console.warn(`${issue.severity} ${issue.code}: ${issue.message} (${issue.path})`);
  for (const category of ['agents', 'prompts', 'models', 'tools', 'handlers', 'hooks', 'effects'] as const) {
    const names = [...registry[category].keys()];
    console.log(`${category}: ${names.join(', ') || '—'}`);
  }
  const failures = issues.filter((issue) => issue.severity === 'error');
  if (failures.length) fail(`\n${failures.length} definition error(s).`);
}

function threadsCommand(options: Options): void {
  const store = new ThreadStore(path.resolve(options.store ?? '.standard-agent'));
  store.recoverStale();
  const records = store.list();
  if (!records.length) {
    console.log(`No threads in ${store.root}`);
    return;
  }
  for (const record of records) {
    const messages = store.loadMessages(record.id);
    const last = [...messages].reverse().find((message) => !message.silent && message.content);
    const kind = record.parent_id ? `child of ${record.parent_id.slice(0, 8)}` : 'root';
    console.log(
      `${record.id}  ${record.agent_id.padEnd(24)} ${record.status.state.padEnd(8)} ${String(messages.length).padStart(3)} msg  ${kind}  ${truncate(last?.content ?? '', 60)}`,
    );
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help) {
    usage();
    if (!command) process.exit(1);
    return;
  }
  switch (command) {
    case 'run':
      await runCommand(options);
      break;
    case 'list':
      await listCommand(options);
      break;
    case 'threads':
      threadsCommand(options);
      break;
    default:
      usage();
      fail(`Unknown command '${command}'`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
