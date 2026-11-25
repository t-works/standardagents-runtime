#!/usr/bin/env node
/**
 * Structural gate for the baseline agent evals: no runtime needed.
 *
 *   node check.mjs
 *
 * It proves the eval set is well formed and that every MUST/SHOULD clause the
 * fixtures claim to test is actually cited by a case, and every manual item has
 * a manual case. It does not execute anything.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const OPS = new Set(['send', 'queueMessage', 'queueTool', 'injectMessage', 'scheduleEffect', 'terminate', 'expectRejected', 'settle', 'createThread', 'sleep', 'restart']);
const KINDS = new Set([
  'messages.roles',
  'messages.contents',
  'messages.attachments',
  'messages.contains',
  'tools.order',
  'tools.args',
  'tools.status',
  'tools.results',
  'tools.maxConcurrent',
  'model.calls',
  'model.views',
  'model.requests',
  'values',
  'status',
  'terminated',
  'children',
  'queue',
  'hooks.order',
  'code',
  'effects',
  'rejected',
  'load.issues',
]);
const ASSERTION_KEYS = new Set(['kind', 'thread', 'index', 'field', 'equals', 'contains', 'notContains', 'notEquals', 'oneOf', 'atLeast', 'length', 'name']);
const EXPECT_ONE_OF = ['equals', 'notEquals', 'contains', 'notContains', 'oneOf', 'atLeast', 'length'];

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

const requirementsDoc = json('requirements.json');
const requirements = new Map(requirementsDoc.requirements.map((entry) => [entry.id, entry]));
if (requirements.size !== requirementsDoc.requirements.length) fail('requirements.json has duplicate requirement ids');

const specPath = path.resolve(here, requirementsDoc.spec);
if (!existsSync(specPath)) fail('requirements.json spec path does not exist: ' + requirementsDoc.spec);
const headings = new Set();
if (existsSync(specPath)) {
  for (const match of readFileSync(specPath, 'utf8').matchAll(/^#{2,3}\s+(\d+(?:\.\d+)*)/gm)) headings.add(match[1]);
  for (const entry of requirements.values()) {
    if (!headings.has(entry.section)) fail('requirement ' + entry.id + ' cites section ' + entry.section + ' which is not a heading in the spec');
  }
}

const fixtureDir = path.join(here, 'fixtures');
const fixtureNames = (category) => {
  const dir = path.join(fixtureDir, category);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.startsWith('_'))
    .map((file) => path.basename(file, '.ts'));
};
const agents = new Set(fixtureNames('agents'));
const RUNTIME_TOOLS = ['subagents', 'subagent_create', 'subagent_message'];
const callables = new Set([...fixtureNames('tools').filter((name) => !name.startsWith('_')), ...fixtureNames('prompts'), ...agents, ...RUNTIME_TOOLS]);

const suiteDir = path.join(here, 'suites');
const suiteFiles = readdirSync(suiteDir).filter((file) => file.endsWith('.json')).sort();
if (!suiteFiles.length) fail('suites/ has no suite files');

const caseIds = new Set();
const cited = new Map();
const automatedCases = [];
const manualCases = [];

for (const file of suiteFiles) {
  const suite = json(path.join('suites', file));
  if (!suite.suite) fail(file + ': missing suite name');
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) fail(file + ': no cases');
  for (const entry of suite.cases ?? []) {
    const where = file + ':' + (entry.id ?? '<missing id>');
    if (!entry.id) fail(where + ': missing id');
    else if (caseIds.has(entry.id)) fail(where + ': duplicate case id');
    else caseIds.add(entry.id);
    if (!Array.isArray(entry.requirements) || entry.requirements.length === 0) fail(where + ': missing requirements');
    for (const id of entry.requirements ?? []) {
      if (!requirements.has(id)) fail(where + ': unknown requirement ' + id);
      if (!cited.has(id)) cited.set(id, []);
      cited.get(id).push(entry.id);
    }
    if (!agents.has(entry.agent)) fail(where + ': agent ' + entry.agent + ' has no file in fixtures/agents');

    const automated = entry.automated !== false && suite.automated !== false;
    if (automated) {
      automatedCases.push(entry);
      if (!entry.why) fail(where + ': automated case needs a why');
      // A case that loads its own package asserts on the load, so it needs no ops.
      if (!entry.load && (!Array.isArray(entry.ops) || entry.ops.length === 0)) fail(where + ': automated case needs ops');
      if (!Array.isArray(entry.expect) || entry.expect.length === 0) fail(where + ': automated case needs expect');
      for (const [index, op] of (entry.ops ?? []).entries()) {
        const names = Object.keys(op).filter((key) => key !== 'async');
        if (names.length !== 1) fail(where + ': ops[' + index + '] must have exactly one key (plus optional async)');
        const name = names[0];
        if (!OPS.has(name)) fail(where + ': unknown op ' + name);
        if (name === 'send' && typeof op.send === 'string') {
          for (const match of op.send.matchAll(/\[\[tool:([A-Za-z0-9_.-]+)/g)) {
            if (!callables.has(match[1])) fail(where + ': send references unknown tool/prompt/agent ' + match[1]);
          }
        }
      }
      for (const [index, expectation] of (entry.expect ?? []).entries()) {
        const at = where + ': expect[' + index + ']';
        if (!KINDS.has(expectation.kind)) fail(at + ': unknown kind ' + expectation.kind);
        for (const key of Object.keys(expectation)) {
          if (!ASSERTION_KEYS.has(key)) fail(at + ': unknown key ' + key);
        }
        if (!EXPECT_ONE_OF.some((key) => key in expectation)) fail(at + ': needs one of ' + EXPECT_ONE_OF.join(', '));
        if ((expectation.kind === 'model.requests' || expectation.kind === 'code') && expectation.index === undefined) {
          warn(at + ': usually needs an index');
        }
      }
    } else {
      manualCases.push(entry);
      if (!entry.manual) fail(where + ': manual case needs a manual description');
      if (entry.ops || entry.expect) fail(where + ': manual case must not declare ops or expect');
    }
  }
}

const automatedRequirement = (entry) => ['automated', 'conditional'].includes(entry.coverage ?? 'automated');
const uncovered = [...requirements.values()].filter((entry) => automatedRequirement(entry) && !cited.has(entry.id));
for (const entry of uncovered) fail('requirement ' + entry.id + ' (' + entry.force + ', section ' + entry.section + ') has no automated case');
const undocumented = [...requirements.values()].filter((entry) => entry.coverage === 'manual' && !cited.has(entry.id));
for (const entry of undocumented) fail('requirement ' + entry.id + ' is manual but no manual case covers it');

for (const entry of requirements.values()) {
  if (entry.coverage === 'optional' && cited.has(entry.id)) warn('requirement ' + entry.id + ' is optional but is asserted by ' + cited.get(entry.id).join(', '));
}

const count = (coverage) => [...requirements.values()].filter((entry) => (entry.coverage ?? 'automated') === coverage).length;
const musts = [...requirements.values()].filter((entry) => entry.force === 'MUST');

for (const message of warnings) console.warn('warning: ' + message);
for (const message of errors) console.error('error: ' + message);

console.log(
  [
    'spec: ' + path.relative(here, specPath).replaceAll('\\', '/'),
    'requirements: ' + requirements.size + ' (' + musts.length + ' MUST, ' + count('manual') + ' manual, ' + count('optional') + ' optional, ' + count('conditional') + ' conditional)',
    'cases: ' + (automatedCases.length + manualCases.length) + ' (' + automatedCases.length + ' automated, ' + manualCases.length + ' manual)',
    'uncovered MUST/SHOULD: ' + uncovered.length,
    errors.length ? 'baseline-evals-check: failed (' + errors.length + ' errors)' : 'baseline-evals-check: ok',
  ].join('\n'),
);
process.exit(errors.length ? 1 : 0);
