// Renders the baseline eval suite as static HTML for human review.
// usage: node evals/docs/build.mjs [--results <file>]
// Reads requirements.json, suites/*.json, the spec headings and a run file from
// run.mjs; writes index.html and, when a run exists, results.html.
// No deps, no client-side JS.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const evalsDir = resolve(here, '..');
const doc = JSON.parse(readFileSync(join(evalsDir, 'requirements.json'), 'utf8'));
const specPath = resolve(evalsDir, doc.spec);
const spec = readFileSync(specPath, 'utf8');
const specName = relative(repo, specPath).replaceAll('\\', '/');

const reqs = new Map(doc.requirements.map((r) => [r.id, r]));
const headings = [...spec.matchAll(/^#{2,3} (\d+(?:\.\d+)*)\.? (.+)$/gm)].map((m) => ({ num: m[1], title: m[2].trim() }));

// The spec numbers 14 twice (code execution, then key-value store); S14K ids mean the second one.
function heading(section, id) {
  const hit = headings.filter((h) => h.num === section);
  return (id.startsWith('S14K') ? hit.at(-1) : hit[0]) ?? { num: section, title: '' };
}

const suites = readdirSync(join(evalsDir, 'suites'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(evalsDir, 'suites', f), 'utf8')) }));

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unknown = [];

function requirement(id) {
  const r = reqs.get(id);
  if (!r) {
    unknown.push(id);
    return null;
  }
  const h = heading(r.section, r.id);
  const label = `§${h.num}${h.title ? ' ' + h.title : ''}`;
  return `<li><details class="req">
        <summary><code>${esc(r.id)}</code> <b class="force ${esc(r.force.toLowerCase())}">${esc(r.force)}</b> <span class="sec">${esc(label)}</span></summary>
        <blockquote>${esc(r.text)}</blockquote>
        <p class="src">Quoted from <code>${esc(specName)}</code>, section ${esc(h.num)}${h.title ? ` &ldquo;${esc(h.title)}&rdquo;` : ''}.</p>
      </details></li>`;
}

function caseCard(c) {
  const automated = c.automated !== false;
  const reqList = (c.requirements ?? []).map(requirement).filter(Boolean).join('\n      ');
  const kinds = [...new Set((c.expect ?? []).map((e) => e.kind))].join(', ');
  const meta = [
    c.agent ? `agent: ${c.agent}` : null,
    `${(c.requirements ?? []).length} requirement${(c.requirements ?? []).length === 1 ? '' : 's'}`,
    automated ? 'automated' : 'manual',
    c.conditional ? 'conditional' : null,
  ].filter(Boolean).join(' · ');
  const body = automated
    ? `<p class="obs">Assertions used by this case, which together discharge the requirements above: <code>${esc(kinds || 'none')}</code>.</p>
        <details class="raw"><summary>What runs (ops)</summary><pre>${esc(JSON.stringify(c.ops ?? [], null, 1))}</pre></details>
        <details class="raw"><summary>What is asserted (expect)</summary><pre>${esc(JSON.stringify(c.expect ?? [], null, 1))}</pre></details>`
    : `<p class="manual"><b>How to check:</b> ${esc(c.manual ?? '')}</p>`;
  // Manual cases (07) carry no `why`; their collapsed line shows the observable check instead.
  const why = c.why || c.manual || '';
  return `  <article class="case" id="${esc(c.id)}">
    <details>
      <summary>
        <code class="cid">${esc(c.id)}</code>
        <span class="why">${esc(why)}</span>
        <span class="meta">${esc(meta)}</span>
      </summary>
      <div class="body">
        ${c.why ? `<h4>How this case demonstrates its requirements</h4>
        <p>${esc(c.why)}</p>` : ''}${c.conditional ? `\n        <p class="cond"><b>Conditional:</b> ${esc(c.conditional)}</p>` : ''}
        <h4>Requirements quoted (expand for source)</h4>
        <ol class="reqs">
      ${reqList}
        </ol>
        ${body}
      </div>
    </details>
  </article>`;
}

const totals = suites.flatMap((s) => s.cases);
const manual = totals.filter((c) => c.automated === false).length;
const toc = suites.map((s) => `      <li><a href="#${esc(s.file.replace('.json', ''))}">${esc(s.file.replace('.json', ''))}</a>
        <span class="n">${s.cases.length} cases</span>
        <ul>${s.cases.map((c) => `<li><a href="#${esc(c.id)}"><code>${esc(c.id)}</code></a></li>`).join('')}</ul></li>`).join('\n');
const sections = suites.map((s) => `  <section id="${esc(s.file.replace('.json', ''))}">
    <h2>${esc(s.file.replace('.json', ''))}</h2>
    <p class="about">${esc(s.about ?? '')}</p>
${s.cases.map(caseCard).join('\n')}
  </section>`).join('\n');

const css = `:root { color-scheme: light dark; --line: #8884; --muted: #6b7280; --accent: #2563eb;
  --ok: #15803d; --bad: #b91c1c; --gap: #a16207; --skip: #6b7280; }
body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin-bottom: .25rem; }
h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
h3 { font-size: 1rem; margin-top: 1.75rem; }
h4 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 1.25rem 0 .25rem; }
code, pre { font-family: ui-monospace, Consolas, monospace; font-size: .85em; }
pre { white-space: pre-wrap; background: #8881; padding: .75rem; border-radius: 4px; overflow-x: auto; }
details > summary { cursor: pointer; }
.case { border: 1px solid var(--line); border-radius: 6px; margin: .6rem 0; }
.case > details > summary { padding: .6rem .8rem; list-style: none; }
.case > details > summary::-webkit-details-marker { display: none; }
.case > details > summary::before { content: "\u25B8 "; color: var(--muted); }
.case > details[open] > summary::before { content: "\u25BE "; }
.cid { color: var(--accent); font-weight: 600; margin-right: .5rem; }
.meta { display: block; margin-left: 1.1rem; color: var(--muted); font-size: .8rem; }
.case .body { padding: 0 .8rem 1rem; border-top: 1px solid var(--line); }
.req { border-left: 3px solid var(--line); margin: .35rem 0; padding: .2rem .6rem; }
.req > summary { list-style: none; }
.req > summary::-webkit-details-marker { display: none; }
.req > summary::marker { content: ""; }
.req > summary::before { content: "\u25B8 "; color: var(--muted); }
.req[open] > summary::before { content: "\u25BE "; }
.force { font-size: .75rem; padding: 0 .35rem; border-radius: 3px; border: 1px solid var(--line); }
.sec { color: var(--muted); }
.reqs { padding-left: 1.2rem; }
blockquote { margin: .5rem 0; padding: .3rem .8rem; border-left: 3px solid var(--accent); background: #8881; }
.src, .obs, .manual { font-size: .85rem; color: var(--muted); }
.about { color: var(--muted); margin-top: .25rem; }
.toc ul { padding-left: 1.1rem; }
.toc .n { color: var(--muted); font-size: .8rem; }
.banner { border: 1px solid var(--line); border-radius: 6px; padding: .6rem .9rem; font-size: .85rem; color: var(--muted); }
.banner b { color: inherit; }
.badge { font-size: .75rem; font-weight: 600; padding: 0 .4rem; border-radius: 3px; border: 1px solid; margin-right: .5rem; white-space: nowrap; }
.badge.pass { color: var(--ok); border-color: var(--ok); }
.badge.fail, .badge.error { color: var(--bad); border-color: var(--bad); }
.badge.not-implemented { color: var(--gap); border-color: var(--gap); }
.badge.manual { color: var(--skip); border-color: var(--skip); }
table { border-collapse: collapse; width: 100%; font-size: .85rem; margin: .5rem 0; }
th, td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr.bad td { background: color-mix(in srgb, var(--bad) 8%, transparent); }
tr.bad td:first-child { box-shadow: inset 3px 0 var(--bad); }
tr.ok td:nth-child(3) { color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${css}</style>
</head>
<body>
${body}
</body>
</html>
`;

const indexHtml = page(
  'Baseline agent evals — human reference',
  `<h1>Baseline agent evals — human reference</h1>
<p class="about">One page per requirement set. Each case shows its id and <em>why</em> while collapsed; expand it for the quoted
requirements, the section each quote comes from, and the ops/assertions that exercise it.
${existsSync(join(here, 'results.html')) ? 'Run outcomes are in <a href="results.html">results.html</a>.' : ''}</p>
<div class="banner">
  <div>Spec: <code>${esc(specName)}</code> (v${esc(doc.specVersion ?? '?')})</div>
  <div>Requirements index: <code>evals/requirements.json</code> — ${reqs.size} entries</div>
  <div>Cases: ${totals.length} (${totals.length - manual} automated, ${manual} manual) across ${suites.length} suites</div>
  <div>Generated by <code>node evals/docs/build.mjs</code>. Do not edit this file by hand.</div>
</div>
<nav class="toc">
  <h2>Contents</h2>
  <ul>
${toc}
  </ul>
</nav>
${sections}`,
);

// ── results page ───────────────────────────────────────────────────────────
const resultsArg = (() => {
  const index = process.argv.indexOf('--results');
  return index === -1 ? null : process.argv[index + 1];
})();
// A curated baseline wins when one exists; otherwise the newest run from run.mjs.
const latestRun = () => {
  const runs = join(evalsDir, 'results', 'runs');
  if (!existsSync(runs)) return null;
  const files = readdirSync(runs).filter((file) => file.endsWith('.json')).sort();
  return files.length ? join(runs, files.at(-1)) : null;
};
const baselinePath = join(evalsDir, 'results', 'baseline.json');
const resultsPath = resultsArg ?? (existsSync(baselinePath) ? baselinePath : latestRun()) ?? baselinePath;

const short = (value) => {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 240 ? text.slice(0, 240) + '…' : text;
};
const badge = (status) => `<span class="badge ${esc(status)}">${esc(status.replace('-', ' '))}</span>`;

function resultsCase(testCase) {
  const declared = totals.find((entry) => entry.id === testCase.id);
  const why = declared?.why || declared?.manual || '';
  const rows = (testCase.assertions ?? [])
    .map(
      (assertion) => `<tr class="${assertion.ok ? 'ok' : 'bad'}">
      <td><code>${esc(assertion.kind)}${assertion.index !== undefined ? `[${assertion.index}]` : ''}${assertion.field ? '.' + esc(assertion.field) : ''}${assertion.thread ? ' · ' + esc(assertion.thread) : ''}</code></td>
      <td><code>${esc(short(assertion.expected))}</code></td>
      <td><code>${assertion.ok ? '—' : esc(short(assertion.actual))}</code></td>
    </tr>`,
    )
    .join('\n');
  const events = testCase.events?.length
    ? `<details class="raw"><summary>Runtime events (${testCase.events.length})</summary><pre>${esc(testCase.events.map((event) => JSON.stringify(event)).join('\n'))}</pre></details>`
    : '';
  return `  <article class="case" id="${esc(testCase.id)}">
    <details>
      <summary>${badge(testCase.status)}<code class="cid">${esc(testCase.id)}</code><span class="why">${esc(why)}</span>
        <span class="meta">${testCase.durationMs} ms${testCase.error ? ' · ' + esc(testCase.error.split('\n')[0]) : ''}</span>
      </summary>
      <div class="body">
        ${testCase.error ? `<p class="manual"><b>Error:</b> ${esc(testCase.error)}</p>` : ''}
        ${rows ? `<h4>Assertions</h4><table><thead><tr><th>surface</th><th>expected</th><th>actual</th></tr></thead>\n<tbody>\n${rows}\n</tbody></table>` : ''}
        ${events}
        <p class="src"><a href="index.html#${esc(testCase.id)}">why this case exists, with quoted requirements →</a></p>
      </div>
    </details>
  </article>`;
}

if (!existsSync(resultsPath)) {
  console.warn(`no results at ${relative(repo, resultsPath)}; wrote index.html only (run run.mjs to produce them)`);
} else {
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const run = results.run;
  const suiteFiles = [...new Set([...(results.cases ?? []).map((entry) => entry.suite), ...(results.manual ?? []).map((entry) => entry.suite)])];
  const count = (list, status) => list.filter((entry) => entry.status === status).length;
  const summaryRows = suiteFiles
    .map((file) => {
      const ran = (results.cases ?? []).filter((entry) => entry.suite === file);
      const manualHere = (results.manual ?? []).filter((entry) => entry.suite === file).length;
      return `<tr><td><a href="#${esc(file.replace('.json', ''))}">${esc(file)}</a></td>
        <td class="num">${count(ran, 'pass')}</td><td class="num">${count(ran, 'fail')}</td>
        <td class="num">${count(ran, 'error')}</td><td class="num">${count(ran, 'not-implemented')}</td>
        <td class="num">${manualHere}</td></tr>`;
    })
    .join('\n');
  const suitesHtml = suiteFiles
    .map((file) => {
      const ran = (results.cases ?? []).filter((entry) => entry.suite === file);
      if (!ran.length) return '';
      const suite = suites.find((entry) => entry.file === file);
      return `  <section id="${esc(file.replace('.json', ''))}">
    <h3>${esc(file)}</h3>
    <p class="about">${esc(suite?.about ?? '')}</p>
${ran.map(resultsCase).join('\n')}
  </section>`;
    })
    .join('\n');
  const manualList = (results.manual ?? []).map((entry) => `<li><a href="index.html#${esc(entry.id)}"><code>${esc(entry.id)}</code></a></li>`).join('');

  const resultsHtml = page(
    `Eval results — ${run.id}`,
    `<h1>Eval results — ${esc(run.id)}</h1>
<p class="about">Outcome of <code>node evals/run.mjs</code>. Expand a case for its id, the <em>why</em>,
and every assertion with the value it expected and got. Cases the runtime cannot satisfy yet say so instead of failing.</p>
<div class="banner">
  <div>Runner <b>${esc(run.runtimeVersion)}</b> · spec <b>${esc(run.specVersion)}</b> · model <b>${esc(run.model ?? 'unrecorded')}</b> · commit <code>${esc(run.gitSha ?? 'nogit')}</code> · node ${esc(run.node)}</div>
  <div>Started ${esc(run.startedAt)} · ${esc(String(run.durationMs))} ms total</div>
  <div>pass <b>${run.totals.pass}</b> · fail <b>${run.totals.fail}</b> · error <b>${run.totals.error}</b> · not implemented <b>${run.totals.notImplemented}</b> · manual <b>${run.totals.manual}</b></div>
  <div>Source: <code>${esc(relative(repo, resultsPath).replaceAll('\\', '/'))}</code></div>
</div>
<h2>Suites</h2>
<table>
  <thead><tr><th>suite</th><th class="num">pass</th><th class="num">fail</th><th class="num">error</th><th class="num">not impl.</th><th class="num">manual</th></tr></thead>
  <tbody>
${summaryRows}
  </tbody>
</table>
${suitesHtml}
${manualList ? `<section id="manual"><h3>Manual cases (not run)</h3>\n<ul>${manualList}</ul></section>` : ''}`,
  );
  writeFileSync(join(here, 'results.html'), resultsHtml);
  console.log(`wrote results.html — ${results.cases.length} cases, pass ${run.totals.pass}, fail ${run.totals.fail}, not-implemented ${run.totals.notImplemented}`);
}

if (unknown.length) {
  console.error('unknown requirement ids cited by cases: ' + [...new Set(unknown)].join(', '));
  process.exit(1);
}
writeFileSync(join(here, 'index.html'), indexHtml);
console.log(`wrote index.html — ${suites.length} suites, ${totals.length} cases, ${reqs.size} requirements quoted`);
