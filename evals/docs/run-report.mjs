// One static HTML page for a single eval run: totals, every case with its
// verdict and failure reason, the assertions, and the turn/message log the run
// recorded. No deps, no client-side JS.
//
// usage: node evals/docs/run-report.mjs [run-file] [--run <file>] [--out <file>]
//
// Runs from run.mjs only carry `events` for non-passing cases, so a passing
// case shows assertions but no turn log. That is a property of the run file,
// not of this page.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const evalsDir = resolve(here, '..');
const runsDir = join(evalsDir, 'results', 'runs');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const HELP = `Single-run eval analytics: one static HTML page with totals, every case
(expandable), its assertion results and, when the run recorded them, its turns
and messages.

usage:
  node evals/docs/run-report.mjs [run-file] [options]

arguments:
  run-file            run JSON written by evals/run.mjs. Default: the newest
                      file in evals/results/runs/. A bare filename is also
                      looked up in evals/results/runs/.

options:
  --run <file>        same as the positional argument
  --results <file>    alias for --run (matches build.mjs)
  --out <file>        output path. Default: evals/docs/evalYY-MM-DD_mm.html,
                      dated from run.startedAt (UTC), overwriting an existing page
  --self-check        run the turn/name helpers on a synthetic run; writes nothing
  -h, --help          show this help

examples:
  node evals/docs/run-report.mjs
  node evals/docs/run-report.mjs 2026-11-24T23-47-23-884Z-b7e063a.json
  node evals/docs/run-report.mjs --run evals/results/baseline.json --out report.html
`;

if (has('--help') || has('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

// ── helpers ────────────────────────────────────────────────────────────────
const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const short = (value, limit = 180) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = (text ?? 'undefined').replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + '…' : oneLine;
};

const val = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

const dur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);

// run.startedAt is ISO UTC, so the page name is dated in UTC too.
function pageName(startedAt, fallbackMs) {
  const parsed = new Date(startedAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date(fallbackMs) : parsed;
  const pad = (n) => String(n).padStart(2, '0');
  return `eval${pad(date.getUTCFullYear() % 100)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCMinutes())}.html`;
}

function newestRun() {
  if (!existsSync(runsDir)) return null;
  const files = readdirSync(runsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, mtime: statSync(join(runsDir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? join(runsDir, files[0].file) : null;
}

function runCandidates(name) {
  return [...new Set([resolve(name), join(runsDir, name), join(evalsDir, name), join(repo, name)])];
}

function resolveRun(name) {
  return runCandidates(name).find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? JSON.stringify(part))))
      .join('\n');
  }
  return JSON.stringify(content);
}

function toolCalls(message) {
  const raw = message?.tool_calls;
  if (!raw) return [];
  let calls = raw;
  if (typeof raw === 'string') {
    try {
      calls = JSON.parse(raw);
    } catch {
      return [{ name: short(raw, 80), args: '' }];
    }
  }
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    const fn = call?.function ?? call ?? {};
    return { name: fn.name ?? '?', args: fn.arguments ?? '' };
  });
}

// Group events per thread, then bucket each thread's items into turns that
// start at a user message. Everything before the first user message is a
// "setup" turn. String events are events that run.mjs truncated.
function groupEvents(events) {
  const threads = new Map();
  for (const raw of events ?? []) {
    const event = typeof raw === 'string' ? { type: 'truncated', raw } : raw;
    const id = event.threadId ?? 'unknown';
    if (!threads.has(id)) threads.set(id, []);
    threads.get(id).push(event);
  }

  const labels = new Map();
  for (const items of threads.values()) {
    for (const event of items) {
      if (event.type === 'subagent' && !labels.has(event.threadId)) {
        labels.set(event.threadId, `${event.relationship ?? 'child'} “${event.name ?? '?'}”`);
      }
    }
  }

  const out = [];
  for (const [id, items] of threads) {
    const turns = [];
    let current = { user: null, items: [] };
    for (const item of items) {
      if (item.type === 'message' && item.message?.role === 'user') {
        if (current.user || current.items.length) turns.push(current);
        current = { user: item.message, items: [] };
      } else {
        current.items.push(item);
      }
    }
    if (current.user || current.items.length) turns.push(current);
    out.push({ id, items, turns, label: labels.get(id) });
  }
  // Main thread first: the one that has a user message.
  return out.sort((a, b) => Number(b.turns.some((turn) => turn.user)) - Number(a.turns.some((turn) => turn.user)));
}

const threadMessageCount = (thread) =>
  thread.items.filter((event) => event.type === 'message').length;

function messageTime(message) {
  if (!message?.created_at) return '';
  const ms = Number(message.created_at) / 1000; // thread messages store microseconds
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) + 'Z' : '';
}

const usageOf = (message) => (isObj(message?.metadata) && isObj(message.metadata.usage) ? message.metadata.usage : null);
const providerOf = (message) =>
  isObj(message?.metadata) && isObj(message.metadata.provider_metadata) ? message.metadata.provider_metadata.model : null;

// ── page bits ──────────────────────────────────────────────────────────────
const badge = (status) => `<span class="badge ${esc(status)}">${esc(String(status).replace('-', ' '))}</span>`;

function reasonList(testCase) {
  const reasons = [];
  if (testCase.error) reasons.push(testCase.error);
  for (const assertion of testCase.assertions ?? []) {
    if (assertion.ok) continue;
    const label = `${assertion.kind}${assertion.index !== undefined ? `[${assertion.index}]` : ''}${assertion.field ? '.' + assertion.field : ''}${assertion.thread ? ' · ' + assertion.thread : ''}`;
    reasons.push(`${label}: expected ${short(assertion.expected, 300)} — got ${short(assertion.actual, 300)}`);
  }
  if (!reasons.length && testCase.status === 'not-implemented') reasons.push('The runtime reports this feature as not implemented (see the events).');
  return reasons;
}

function messageCard(message, time) {
  const role = message.role ?? 'message';
  const calls = toolCalls(message);
  const usage = usageOf(message);
  const provider = providerOf(message);
  const details = [];
  if (message.name) details.push(`name ${esc(message.name)}`);
  if (message.tool_call_id) details.push(`call ${esc(message.tool_call_id)}`);
  if (message.tool_status) details.push(`tool ${esc(message.tool_status)}`);
  if (message.status && message.status !== 'completed') details.push(`status ${esc(message.status)}`);
  if (message.silent) details.push('silent');
  if (message.depth) details.push(`depth ${esc(message.depth)}`);
  if (Array.isArray(message.attachments) && message.attachments.length) details.push(`${message.attachments.length} attachment(s)`);
  if (time) details.push(time);
  if (provider) details.push(esc(provider));
  if (usage) details.push(`tokens ${esc(usage.promptTokens ?? '?')}/${esc(usage.completionTokens ?? '?')}/${esc(usage.totalTokens ?? '?')}${usage.cachedTokens ? ` · cached ${esc(usage.cachedTokens)}` : ''}`);

  const body = textOf(message.content);
  const callsHtml = calls.length
    ? `<div class="calls">${calls
        .map((call) => `<div><code>${esc(call.name)}</code>${call.args ? `<span class="args">${esc(textOf(call.args))}</span>` : ''}</div>`)
        .join('')}</div>`
    : '';
  const reasoning = message.reasoning_content
    ? `<details class="reasoning"><summary>reasoning</summary><pre>${esc(textOf(message.reasoning_content))}</pre></details>`
    : '';
  const attachments =
    Array.isArray(message.attachments) && message.attachments.length
      ? `<pre class="attachments">${esc(JSON.stringify(message.attachments, null, 1))}</pre>`
      : '';

  return `<div class="msg role-${esc(role)}">
  <div class="msg-head"><b>${esc(role)}</b>${details.length ? ` <span class="meta">${details.join(' · ')}</span>` : ''}</div>
  ${body ? `<pre>${esc(body)}</pre>` : '<p class="empty">(no content)</p>'}
  ${callsHtml}
  ${attachments}
  ${reasoning}
</div>`;
}

function eventLine(event) {
  if (typeof event === 'string') return `<pre class="truncated">${esc(event)}</pre>`;
  const type = event.type ?? 'event';
  if (type === 'tool_started') {
    return `<div class="ev"><code>tool_started</code> ${esc(event.name ?? '?')}${event.progress != null ? ` <span class="meta">${esc(short(event.progress, 80))}</span>` : ''}</div>`;
  }
  if (type === 'tool_done') {
    const bad = event.status && event.status !== 'success';
    return `<div class="ev${bad ? ' bad' : ''}"><code>tool_done</code> ${esc(event.name ?? '?')} · ${esc(event.status ?? '?')}${event.error ? ` · ${esc(event.error)}` : ''}</div>`;
  }
  if (type === 'status') {
    return `<div class="ev"><code>status</code> ${esc(event.status?.state ?? '?')}${event.status?.reason ? ` · ${esc(event.status.reason)}` : ''}</div>`;
  }
  if (type === 'subagent') {
    return `<div class="ev"><code>subagent</code> ${esc(event.relationship ?? '?')} “${esc(event.name ?? '?')}” · ${esc(event.status ?? '?')}</div>`;
  }
  if (type === 'error' || type === 'log') {
    return `<div class="ev bad"><code>${esc(type)}</code> ${esc(event.message ?? '')}</div>`;
  }
  if (type === 'truncated') return eventLine(event.raw);
  const data = Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'threadId'].includes(key)));
  return `<div class="ev"><code>${esc(type)}</code>${event.event ? ` ${esc(event.event)}` : ''}${Object.keys(data).length ? ` ${esc(short(data, 160))}` : ''}</div>`;
}

function turnCard(turn, index) {
  const messages = turn.items.filter((item) => item.type === 'message');
  const other = turn.items.length - messages.length;
  const preview = turn.user ? short(textOf(turn.user.content), 120) : short(textOf(messages[0]?.message?.content ?? ''), 120) || '(no message)';
  const label = index == null ? 'Setup' : `Turn ${index}`;
  const counts = [
    `${messages.length} message${messages.length === 1 ? '' : 's'}`,
    other ? `${other} event${other === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const items = turn.items
    .map((item) =>
      item.type === 'message'
        ? messageCard(item.message, messageTime(item.message))
        : eventLine(item),
    )
    .join('\n');

  return `<details class="turn">
  <summary><span class="tnum">${esc(label)}</span> <span class="preview">${esc(preview)}</span> <span class="meta">${esc(counts)}</span></summary>
  <div class="turn-body">
    ${turn.user ? messageCard(turn.user, messageTime(turn.user)) : '<p class="empty">Nothing before the first user message.</p>'}
    ${items}
  </div>
</details>`;
}

function threadsHtml(testCase) {
  if (!testCase.events?.length) {
    return `<p class="empty">This run file has no turn log for this case. <code>evals/run.mjs</code> keeps <code>events</code>
      only for cases that did not pass, so the assertion results on the left are the whole record. Re-run the case
      over a live model or force a failure to capture messages.</p>`;
  }
  const threads = groupEvents(testCase.events);
  if (!threads.length) return '<p class="empty">No events recorded.</p>';
  return threads
    .map((thread, threadIndex) => {
      const label = thread.label ? `thread ${threadIndex + 1} — ${thread.label}` : `thread ${threadIndex + 1}`;
      let turnNumber = 0;
      const turns = thread.turns.map((turn) => turnCard(turn, turn.user ? ++turnNumber : null)).join('\n');
      return `<section class="thread">
  <h5>${esc(label)} <span class="meta"><code>${esc(thread.id)}</code> · ${threadMessageCount(thread)} messages · ${thread.turns.length} turns</span></h5>
  ${turns}
</section>`;
    })
    .join('\n');
}

function assertionTable(assertions) {
  if (!assertions.length) return '<p class="empty">No assertions.</p>';
  const rows = assertions
    .map(
      (assertion) => `<tr class="${assertion.ok ? 'ok' : 'bad'}">
      <td>${assertion.ok ? '<span class="tick ok">pass</span>' : '<span class="tick bad">fail</span>'}</td>
      <td><code>${esc(assertion.kind)}${assertion.index !== undefined ? `[${assertion.index}]` : ''}${assertion.field ? '.' + esc(assertion.field) : ''}${assertion.thread ? ' · ' + esc(assertion.thread) : ''}</code></td>
      <td><code>${esc(short(assertion.expected, 500))}</code></td>
      <td>${assertion.ok ? '<span class="meta">matched</span>' : `<code>${esc(short(assertion.actual, 500))}</code>`}</td>
    </tr>`,
    )
    .join('\n');
  return `<table class="assertions">
  <thead><tr><th></th><th>surface</th><th>expected</th><th>actual</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function caseCard(testCase, definition) {
  const reasons = reasonList(testCase);
  const failed = (testCase.assertions ?? []).filter((assertion) => !assertion.ok).length;
  const passed = (testCase.assertions ?? []).length - failed;
  const reason = reasons[0] ?? '';
  const meta = [
    dur(testCase.durationMs ?? 0),
    `${passed} assertion${passed === 1 ? '' : 's'} passed${failed ? `, ${failed} failed` : ''}`,
    testCase.store ? `store ${testCase.store}` : null,
  ].filter(Boolean);
  const definitionMeta = definition
    ? [
        definition.agent ? `agent ${definition.agent}` : null,
        definition.requirements?.length ? `${definition.requirements.length} requirement(s): ${definition.requirements.join(', ')}` : null,
      ].filter(Boolean).join(' · ')
    : '';

  return `<article class="case" id="case-${esc(testCase.id)}">
  <details>
    <summary>
      ${badge(testCase.status)}
      <code class="cid">${esc(testCase.id)}</code>
      ${definition?.why ? `<span class="why">${esc(definition.why)}</span>` : ''}
      <span class="meta">${esc(meta.join(' · '))}</span>
      ${reason && testCase.status !== 'pass' ? `<span class="reason">${esc(short(reason, 220))}</span>` : ''}
    </summary>
    <div class="body">
      <div class="cols">
        <div class="col">
          ${reasons.length ? `<h4>Why it ${testCase.status === 'pass' ? 'passed' : 'failed'}</h4>
          <ul class="reasons">${reasons.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul>` : '<h4>Outcome</h4><p class="empty">Passed every assertion.</p>'}
          <h4>Case details</h4>
          <dl class="facts">
            <dt>suite</dt><dd><a href="#suite-${esc(testCase.suite.replace('.json', ''))}">${esc(testCase.suite)}</a></dd>
            <dt>duration</dt><dd>${esc(dur(testCase.durationMs ?? 0))}</dd>
            ${definitionMeta ? `<dt>definition</dt><dd>${esc(definitionMeta)}</dd>` : ''}
            ${testCase.store ? `<dt>store</dt><dd><code>${esc(testCase.store)}</code></dd>` : ''}
            ${testCase.error ? `<dt>error</dt><dd>${esc(testCase.error)}</dd>` : ''}
          </dl>
          <h4>Assertions <span class="meta">${passed} passed${failed ? ` · ${failed} failed` : ''}</span></h4>
          ${assertionTable(testCase.assertions ?? [])}
        </div>
        <div class="col">
          <h4>Turns and messages</h4>
          ${threadsHtml(testCase)}
        </div>
      </div>
    </div>
  </details>
</article>`;
}

// ── self-check ─────────────────────────────────────────────────────────────
function selfCheck() {
  assert.equal(pageName('2026-11-24T23:47:23.884Z'), 'eval26-11-24_47.html');
  assert.equal(pageName(undefined, Date.UTC(2026, 0, 2, 3, 4)), 'eval26-01-02_04.html');
  const threads = groupEvents([
    { type: 'status', threadId: 't', status: { state: 'running' } },
    { type: 'message', threadId: 't', message: { role: 'user', content: 'hello' } },
    { type: 'message', threadId: 't', message: { role: 'assistant', content: 'hi' } },
    { type: 'tool_started', threadId: 't', name: 'x' },
    { type: 'message', threadId: 't', message: { role: 'user', content: 'again' } },
    { type: 'explode' },
  ]);
  assert.equal(threads.length, 2, 'two threads');
  const main = threads.find((thread) => thread.id === 't');
  assert.equal(main.turns.length, 3, 'setup turn + two user turns');
  assert.equal(main.turns[1].user.content, 'hello');
  assert.equal(main.turns[1].items.length, 2, 'assistant + tool_started');
  assert.equal(main.turns[2].user.content, 'again');
  assert.equal(toolCalls({ tool_calls: '[{"function":{"name":"n","arguments":"{}"}}]' })[0].name, 'n');
  console.log('self-check ok — turn grouping, page naming, tool-call parsing');
}

if (has('--self-check')) {
  selfCheck();
  process.exit(0);
}

// ── load ───────────────────────────────────────────────────────────────────
const positional = (() => {
  for (let index = 0; index < argv.length; index++) {
    if (['--run', '--results', '--out'].includes(argv[index])) {
      index++;
      continue;
    }
    if (!argv[index].startsWith('-')) return argv[index];
  }
  return undefined;
})();
const explicit = flag('--run') ?? flag('--results') ?? positional;
const runPath = explicit ? resolveRun(explicit) : newestRun();
if (!runPath) {
  console.error(
    explicit
      ? `no run file found for ${explicit}\nlooked in: ${runCandidates(explicit).join(', ')}`
      : `no run files in ${relative(repo, runsDir)}; run node evals/run.mjs first`,
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(runPath, 'utf8'));
} catch (error) {
  console.error(`cannot read ${relative(repo, runPath)}: ${error.message}`);
  process.exit(1);
}
if (!isObj(data?.run) || !Array.isArray(data.cases)) {
  console.error(`${relative(repo, runPath)} is not a run file from evals/run.mjs (expected {run, cases})`);
  process.exit(1);
}

// Suite definitions give each case its `why`, requirements and agent. Missing
// files or cases just fall back to the run's own fields.
const definitions = new Map();
const suiteAbout = new Map();
for (const file of readdirSync(join(evalsDir, 'suites')).filter((name) => name.endsWith('.json')).sort()) {
  const suite = JSON.parse(readFileSync(join(evalsDir, 'suites', file), 'utf8'));
  suiteAbout.set(file, suite.about ?? '');
  for (const testCase of suite.cases ?? []) {
    definitions.set(testCase.id, { ...testCase, suiteFile: file, about: suite.about ?? '' });
  }
}

const run = data.run;
const cases = data.cases;
const manual = data.manual ?? [];
const ran = cases.length;
const pass = run.totals?.pass ?? cases.filter((entry) => entry.status === 'pass').length;
const fail = run.totals?.fail ?? cases.filter((entry) => entry.status === 'fail').length;
const errors = run.totals?.error ?? cases.filter((entry) => entry.status === 'error').length;
const notImplemented = run.totals?.notImplemented ?? cases.filter((entry) => entry.status === 'not-implemented').length;
const manualCount = run.totals?.manual ?? manual.length;
const assertions = cases.flatMap((entry) => entry.assertions ?? []);
const failedAssertions = assertions.filter((assertion) => !assertion.ok).length;
const slowest = [...cases].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
const withEvents = cases.filter((entry) => entry.events?.length).length;
const sourceFile = relative(repo, runPath).replaceAll('\\', '/');
const generatedAt = new Date().toISOString();
const startedMs = Date.parse(run.startedAt);
const outPath = flag('--out') ? resolve(flag('--out')) : join(here, pageName(run.startedAt, startedMs || statSync(runPath).mtimeMs));

const suiteFiles = [...new Set([...cases.map((entry) => entry.suite), ...manual.map((entry) => entry.suite)])];
const countStatus = (list, status) => list.filter((entry) => entry.status === status).length;

const failureRows = cases
  .filter((entry) => entry.status !== 'pass')
  .map((entry) => {
    const reasons = reasonList(entry);
    return `<tr><td>${badge(entry.status)}</td><td><a href="#case-${esc(entry.id)}"><code>${esc(entry.id)}</code></a></td><td>${esc(short(reasons[0] ?? '', 300))}</td></tr>`;
  })
  .join('\n');

const metric = (label, value, hint = '') =>
  `<div class="metric"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${hint ? `<div class="h">${esc(hint)}</div>` : ''}</div>`;

const metrics = [
  metric('cases', ran, `${suiteFiles.length} files`),
  metric('pass', pass, `${ran ? ((pass / ran) * 100).toFixed(0) : 0}% of cases`),
  metric('fail', fail, fail ? 'see failures below' : 'none'),
  metric('error', errors, errors ? 'harness or runtime threw' : 'none'),
  metric('not implemented', notImplemented, notImplemented ? 'known gaps' : 'none'),
  metric('manual', manualCount, 'not run'),
  metric('assertions', assertions.length, `${failedAssertions} failed`),
  metric('duration', dur(run.durationMs ?? 0), `avg ${dur(ran ? Math.round((run.durationMs ?? 0) / ran) : 0)}`),
  slowest ? metric('slowest case', dur(slowest.durationMs ?? 0), short(slowest.id, 28)) : '',
  metric('turn logs', withEvents, `of ${ran} cases`),
];

const files = suiteFiles
  .map((file) => {
    const rained = cases.filter((entry) => entry.suite === file);
    const man = manual.filter((entry) => entry.suite === file);
    const counts = [
      rained.length ? `${rained.length} run` : null,
      countStatus(rained, 'pass') ? `${countStatus(rained, 'pass')} pass` : null,
      countStatus(rained, 'fail') ? `${countStatus(rained, 'fail')} fail` : null,
      countStatus(rained, 'error') && `${countStatus(rained, 'error')} error`,
      countStatus(rained, 'not-implemented') ? `${countStatus(rained, 'not-implemented')} not implemented` : null,
      man.length ? `${man.length} manual` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const fileDuration = rained.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
    const about = suiteAbout.get(file) ?? '';
    return `<details class="suite" id="suite-${esc(file.replace('.json', ''))}">
  <summary><code>${esc(file)}</code> <span class="meta">${esc(counts)}${rained.length ? ` · ${esc(dur(fileDuration))}` : ''}</span></summary>
  ${about ? `<p class="about">${esc(about)}</p>` : ''}
  ${rained.map((entry) => caseCard(entry, definitions.get(entry.id))).join('\n')}
  ${
    man.length
      ? `<details class="manual-cases"><summary>Manual cases in this file (${man.length}, not run)</summary><ul>${man
          .map((entry) => {
            const definition = definitions.get(entry.id);
            return `<li><code>${esc(entry.id)}</code>${definition?.why || definition?.manual ? ` — ${esc(definition.why || definition.manual)}` : ''}</li>`;
          })
          .join('')}</ul></details>`
      : ''
  }
</details>`;
  })
  .join('\n');

const css = `:root { color-scheme: light dark; --line: #8884; --muted: #6b7280; --accent: #2563eb;
  --ok: #15803d; --bad: #b91c1c; --gap: #a16207; --skip: #6b7280; --tint: #8881; }
* { box-sizing: border-box; }
body { font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 1.5rem clamp(1rem, 3vw, 3rem) 4rem; }
main { max-width: 1900px; margin: 0 auto; }
h1 { font-size: 1.45rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
h4 { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 1.1rem 0 .35rem; }
h5 { font-size: .85rem; margin: 1.1rem 0 .4rem; }
code, pre { font-family: ui-monospace, Consolas, monospace; font-size: .85em; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--tint); padding: .55rem .7rem; border-radius: 4px; margin: .35rem 0; }
a { color: var(--accent); }
.about, .meta, .empty, .h { color: var(--muted); font-size: .82rem; }
.about { margin: .2rem 0 .6rem; }
.empty { font-style: italic; }
.banner { border: 1px solid var(--line); border-radius: 6px; padding: .6rem .9rem; font-size: .85rem; color: var(--muted); display: grid; gap: .15rem; }
.banner b { color: inherit; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .55rem; }
.metric { border: 1px solid var(--line); border-radius: 6px; padding: .55rem .75rem; }
.metric .k { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.metric .v { font-size: 1.45rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; font-size: .72rem; font-weight: 700; padding: .05rem .4rem; border-radius: 3px; border: 1px solid; margin-right: .45rem; white-space: nowrap; text-transform: uppercase; }
.badge.pass, .tick.ok { color: var(--ok); border-color: var(--ok); }
.badge.fail, .badge.error, .tick.bad { color: var(--bad); border-color: var(--bad); }
.badge.not-implemented { color: var(--gap); border-color: var(--gap); }
.badge.manual { color: var(--skip); border-color: var(--skip); }
.tick { font-size: .72rem; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
.tick.ok { border: 0; }
.tick.bad { border: 0; }
details > summary { cursor: pointer; }
details > summary::marker { content: ""; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "\\25B8"; color: var(--muted); margin-right: .45rem; }
details[open] > summary::before { content: "\\25BE"; }
.suite { border: 1px solid var(--line); border-radius: 6px; margin: .55rem 0; padding: .25rem .7rem .6rem; }
.suite > summary { padding: .45rem .1rem; }
.suite .about { margin-left: 1.1rem; }
.case { border: 1px solid var(--line); border-radius: 6px; margin: .5rem 0; }
.case > details > summary { padding: .5rem .65rem; }
.cid { color: var(--accent); font-weight: 650; margin-right: .45rem; }
.why { margin-right: .4rem; }
.case > details > summary .meta { display: block; margin-left: 1.45rem; }
.reason { display: block; margin: .2rem 0 0 1.45rem; color: var(--bad); font-size: .82rem; }
.case .body { padding: .2rem .75rem .9rem; border-top: 1px solid var(--line); }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 1.5rem; align-items: start; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.reasons { margin: .2rem 0; padding-left: 1.2rem; color: var(--bad); }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .1rem .7rem; margin: .2rem 0; font-size: .84rem; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; word-break: break-word; }
table { border-collapse: collapse; width: 100%; font-size: .82rem; margin: .35rem 0; }
th, td { text-align: left; padding: .28rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td code { word-break: break-word; }
tr.bad td { background: color-mix(in srgb, var(--bad) 8%, transparent); }
tr.bad td:first-child { box-shadow: inset 3px 0 var(--bad); }
.turn { border-left: 2px solid var(--line); margin: .4rem 0; padding: .1rem 0 .1rem .55rem; }
.turn > summary { padding: .2rem 0; }
.tnum { font-weight: 650; margin-right: .35rem; }
.preview { margin-right: .35rem; }
.turn-body { padding: .1rem 0 .3rem .3rem; }
.msg { border: 1px solid var(--line); border-radius: 5px; margin: .4rem 0; padding: .35rem .55rem; }
.msg.role-user { border-left: 3px solid var(--accent); }
.msg.role-assistant { border-left: 3px solid var(--ok); }
.msg.role-tool { border-left: 3px solid var(--gap); }
.msg-head { font-size: .8rem; }
.msg-head b { text-transform: uppercase; letter-spacing: .03em; }
.calls { margin: .2rem 0; font-size: .82rem; }
.calls .args { color: var(--muted); margin-left: .45rem; word-break: break-all; }
.ev { font-size: .8rem; padding: .12rem 0; color: var(--muted); }
.ev.bad { color: var(--bad); }
.ev code, .truncated { color: inherit; }
.thread > h5 code { font-size: .78rem; }
.manual-cases { margin: .6rem 0 .1rem; }
.manual-cases ul { margin: .3rem 0; padding-left: 1.2rem; font-size: .85rem; }
`;

const body = `<main>
<h1>Eval run — ${esc(run.id ?? relative(repo, runPath))}</h1>
<p class="about">One run, one page. Expand a file to see its cases; expand a case for the verdict, every assertion
(expected vs. actual) and the turn/message log the run recorded. Wide screens keep assertions and turns side by side.</p>
<div class="banner">
  <div>Model <b>${esc(run.model ?? 'unrecorded')}</b> · runtime <b>${esc(run.runtimeVersion ?? '?')}</b> · spec <b>${esc(run.specVersion ?? '?')}</b> · commit <code>${esc(run.gitSha ?? 'nogit')}</code> · node ${esc(run.node ?? '?')}</div>
  <div>Started ${esc(run.startedAt ?? '?')} · ${esc(dur(run.durationMs ?? 0))} total · source <code>${esc(sourceFile)}</code></div>
  <div>Page generated ${esc(generatedAt)} by <code>node evals/docs/run-report.mjs</code>. Do not edit by hand.</div>
</div>

<h2>At a glance</h2>
<div class="metrics">
${metrics.filter(Boolean).join('\n')}
</div>

${failureRows ? `<h2>Failures and gaps (${cases.filter((entry) => entry.status !== 'pass').length})</h2>
<table class="failures">
  <thead><tr><th>status</th><th>case</th><th>first reason</th></tr></thead>
  <tbody>
${failureRows}
  </tbody>
</table>` : '<h2>Failures and gaps</h2><p class="empty">Every case in this run passed.</p>'}

${withEvents < ran ? `<p class="about">Turn logs exist for ${withEvents} of ${ran} cases: <code>evals/run.mjs</code> records <code>events</code> only when a case does not pass. Passing cases show their assertions as evidence.</p>` : ''}

<h2>Files</h2>
<p class="about">Each file is a suite from <code>evals/suites/</code>. Expand it for its cases.</p>
${files}
${manual.length ? `<p class="src">Manual cases are listed inside their suite and are never executed by <code>run.mjs</code>.</p>` : ''}
</main>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval run ${esc(run.id ?? '')}</title>
<style>
${css}</style>
</head>
<body>
${body}
</body>
</html>
`;

writeFileSync(outPath, html);
console.log(
  `wrote ${relative(repo, outPath).replaceAll('\\', '/')} — ${ran} cases, pass ${pass}, fail ${fail}, error ${errors}, not-implemented ${notImplemented}, manual ${manualCount} (${sourceFile})`,
);
