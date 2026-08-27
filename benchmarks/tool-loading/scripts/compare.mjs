#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(scriptDir, '..');
const tasks = JSON.parse(readFileSync(resolve(benchDir, 'tasks.json'), 'utf8')).tasks;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function walkJson(dir) {
  if (!existsSync(dir)) return [];
  const paths = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) paths.push(...walkJson(full));
    else if (entry.endsWith('.json')) paths.push(full);
  }
  return paths;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(values) {
  if (values.length === 0) return null;
  return values.filter(Boolean).length / values.length;
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function num(value, digits = 0) {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function reportedTokens(run) {
  const usage = run.usage ?? {};
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function valid(run) {
  return run.exitCode === 0 && !run.timedOut;
}

const runDirArg = arg('--run-dir');
if (!runDirArg) {
  console.error('Usage: node compare.mjs --run-dir <dir> [--record]');
  process.exit(2);
}

const runDir = resolve(runDirArg);
const cases = walkJson(resolve(runDir, 'cases')).map((path) => JSON.parse(readFileSync(path, 'utf8')));
if (cases.length === 0) {
  console.error(`No case JSON files found under ${runDir}`);
  process.exit(1);
}

const byKey = new Map();
for (const run of cases) {
  byKey.set(`${run.mode}:${run.taskId}:${String(run.repetition)}`, run);
}

const taskMetrics = [];
for (const task of tasks) {
  const baseline = cases.filter((run) => run.taskId === task.id && run.mode === 'baseline' && valid(run));
  const deferred = cases.filter((run) => run.taskId === task.id && run.mode === 'deferred' && valid(run));
  if (baseline.length === 0 && deferred.length === 0) continue;

  const baselineTarget = task.kind === 'positive' ? rate(baseline.map((run) => run.targetHit)) : null;
  const deferredTarget = task.kind === 'positive' ? rate(deferred.map((run) => run.targetHit)) : null;
  const deferredDiscovery =
    task.kind === 'positive'
      ? rate(deferred.map((run) => run.targetHit && run.searchCalls > 0 && run.loaderBeforeTarget))
      : null;
  const baselineLoaderFree = rate(baseline.map((run) => run.searchCalls === 0));
  const deferredLoaderFree = rate(deferred.map((run) => run.searchCalls === 0));

  const baselinePairs = baseline.filter((run) => run.targetHit);
  let retained = 0;
  for (const baseRun of baselinePairs) {
    const peer = byKey.get(`deferred:${task.id}:${String(baseRun.repetition)}`);
    if (peer && valid(peer) && peer.targetHit) retained += 1;
  }
  const pairedRetention = baselinePairs.length > 0 ? retained / baselinePairs.length : null;

  taskMetrics.push({
    id: task.id,
    kind: task.kind,
    runs: { baseline: baseline.length, deferred: deferred.length },
    baselineTargetRate: baselineTarget,
    deferredTargetRate: deferredTarget,
    deferredDiscoveryRate: deferredDiscovery,
    pairedRetention,
    baselineLoaderFreeRate: baselineLoaderFree,
    deferredLoaderFreeRate: deferredLoaderFree,
    baselineAvgTokens: mean(baseline.map(reportedTokens)),
    deferredAvgTokens: mean(deferred.map(reportedTokens)),
    baselineAvgDurationMs: mean(baseline.map((run) => run.durationMs)),
    deferredAvgDurationMs: mean(deferred.map((run) => run.durationMs)),
    baselineAvgToolCalls: mean(baseline.map((run) => run.toolCalls.length)),
    deferredAvgToolCalls: mean(deferred.map((run) => run.toolCalls.length)),
    deferredAvgSearchCalls: mean(deferred.map((run) => run.searchCalls)),
    weakProbe: task.kind === 'positive' && (baselineTarget ?? 0) < 0.6,
  });
}

const positiveTasks = taskMetrics.filter((metric) => metric.kind === 'positive' && !metric.weakProbe);
const negativeTasks = taskMetrics.filter((metric) => metric.kind === 'negative');
const positiveRuns = cases.filter(
  (run) => valid(run) && run.taskKind === 'positive' && !taskMetrics.find((metric) => metric.id === run.taskId)?.weakProbe,
);
const baselinePositiveRuns = positiveRuns.filter((run) => run.mode === 'baseline');
const deferredPositiveRuns = positiveRuns.filter((run) => run.mode === 'deferred');
const baselineHits = baselinePositiveRuns.filter((run) => run.targetHit);
let retainedHits = 0;
for (const run of baselineHits) {
  const peer = byKey.get(`deferred:${run.taskId}:${String(run.repetition)}`);
  if (peer && valid(peer) && peer.targetHit) retainedHits += 1;
}

const primaryRetention = baselineHits.length > 0 ? retainedHits / baselineHits.length : null;
const deferredDiscoveryRate = rate(
  deferredPositiveRuns.map((run) => run.targetHit && run.searchCalls > 0 && run.loaderBeforeTarget),
);
const negativeDeferredRuns = cases.filter((run) => valid(run) && run.taskKind === 'negative' && run.mode === 'deferred');
const negativeLoaderAvoidance = rate(negativeDeferredRuns.map((run) => run.searchCalls === 0));
const baselineAvgTokens = mean(cases.filter((run) => valid(run) && run.mode === 'baseline').map(reportedTokens));
const deferredAvgTokens = mean(cases.filter((run) => valid(run) && run.mode === 'deferred').map(reportedTokens));
const tokenDeltaPct =
  baselineAvgTokens && deferredAvgTokens !== null ? (deferredAvgTokens - baselineAvgTokens) / baselineAvgTokens : null;
const baselineAvgDurationMs = mean(cases.filter((run) => valid(run) && run.mode === 'baseline').map((run) => run.durationMs));
const deferredAvgDurationMs = mean(cases.filter((run) => valid(run) && run.mode === 'deferred').map((run) => run.durationMs));
const latencyDeltaPct =
  baselineAvgDurationMs && deferredAvgDurationMs !== null
    ? (deferredAvgDurationMs - baselineAvgDurationMs) / baselineAvgDurationMs
    : null;

const preflight = existsSync(resolve(runDir, 'preflight.json'))
  ? JSON.parse(readFileSync(resolve(runDir, 'preflight.json'), 'utf8'))
  : null;
const validCases = cases.filter(valid);
const observedModels = [
  ...new Set(
    validCases.map((run) => `${run.provider ?? 'unknown'}/${run.model ?? 'unknown'}`),
  ),
].toSorted();

const metrics = {
  version: 1,
  runId: basename(runDir),
  generatedAt: new Date().toISOString(),
  preflight,
  observedModels,
  modelConsistent: observedModels.length <= 1,
  counts: {
    cases: cases.length,
    validCases: validCases.length,
    invalidCases: cases.length - validCases.length,
    strongPositiveTasks: positiveTasks.length,
    weakPositiveTasks: taskMetrics.filter((metric) => metric.weakProbe).length,
    negativeTasks: negativeTasks.length,
  },
  primary: {
    pairedDiscoveryRetention: primaryRetention,
    deferredDiscoveryRate,
    negativeControlLoaderAvoidance: negativeLoaderAvoidance,
    baselineAvgReportedTokens: baselineAvgTokens,
    deferredAvgReportedTokens: deferredAvgTokens,
    reportedTokenDeltaPct: tokenDeltaPct,
    baselineAvgDurationMs,
    deferredAvgDurationMs,
    latencyDeltaPct,
  },
  tasks: taskMetrics,
};

writeFileSync(resolve(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');

const lines = [
  '# Tool-loading benchmark comparison',
  '',
  `Run: \`${metrics.runId}\``,
  `Model: \`${observedModels.join(', ') || `${preflight?.actualProvider ?? 'unknown'}/${preflight?.actualModel ?? 'unknown'}`}\``,
  `Valid cases: ${String(metrics.counts.validCases)}/${String(metrics.counts.cases)}`,
  '',
  '## Primary result',
  '',
  `- Paired discovery retention: **${pct(primaryRetention)}**`,
  `- Deferred discovery success: **${pct(deferredDiscoveryRate)}**`,
  `- Negative-control loader avoidance: **${pct(negativeLoaderAvoidance)}**`,
  `- Reported token delta: **${pct(tokenDeltaPct)}** (${num(baselineAvgTokens)} baseline -> ${num(deferredAvgTokens)} deferred)`,
  `- Wall-clock latency delta: **${pct(latencyDeltaPct)}** (${num(baselineAvgDurationMs)} ms -> ${num(deferredAvgDurationMs)} ms)`,
  '',
  'Paired discovery retention is the main reliability number: when baseline Pi used the intended specialist tool, how often did deferred Pi still find and use it?',
  '',
  '## Per task',
  '',
  '| Task | Baseline target | Deferred target | Deferred discovery | Paired retention | Tokens B/D | Latency B/D | Note |',
  '|---|---:|---:|---:|---:|---:|---:|---|',
];

for (const metric of taskMetrics) {
  const targetBaseline = metric.kind === 'positive' ? pct(metric.baselineTargetRate) : 'control';
  const targetDeferred = metric.kind === 'positive' ? pct(metric.deferredTargetRate) : 'control';
  const discovery = metric.kind === 'positive' ? pct(metric.deferredDiscoveryRate) : pct(metric.deferredLoaderFreeRate);
  const retention = metric.kind === 'positive' ? pct(metric.pairedRetention) : 'n/a';
  const note = metric.weakProbe ? 'weak probe: baseline rarely used target' : '';
  lines.push(
    `| ${metric.id} | ${targetBaseline} | ${targetDeferred} | ${discovery} | ${retention} | ${num(metric.baselineAvgTokens)}/${num(metric.deferredAvgTokens)} | ${num(metric.baselineAvgDurationMs)}/${num(metric.deferredAvgDurationMs)} ms | ${note} |`,
  );
}

lines.push(
  '',
  '## Interpretation',
  '',
  '- Reliability is good when paired discovery retention stays near 100%.',
  '- Negative controls should avoid `search_tools`; unnecessary searches are overhead.',
  '- Treat weak probes as task-design failures, not deferred-loader failures.',
  '- Token and latency deltas are secondary to reliability; compare them only after the same task/model/config has enough valid repetitions.',
);
if (!metrics.modelConsistent) {
  lines.push('- WARNING: multiple models were observed; do not treat this run as a clean A/B comparison.');
}
if (metrics.counts.invalidCases > 0) {
  lines.push(`- WARNING: ${String(metrics.counts.invalidCases)} failed or timed-out cases were excluded.`);
}
lines.push('');

writeFileSync(resolve(runDir, 'comparison.md'), `${lines.join('\n')}\n`, 'utf8');

if (hasFlag('--record')) {
  const historyPath = resolve(benchDir, 'results', 'history.jsonl');
  const historyEntry = {
    runId: metrics.runId,
    generatedAt: metrics.generatedAt,
    gitSha: preflight?.gitSha ?? null,
    gitDirty: preflight?.gitDirty ?? null,
    taskSuiteSha256: preflight?.taskSuiteSha256 ?? null,
    benchmarkConfigSha256: preflight?.benchmarkConfigSha256 ?? null,
    piVersion: preflight?.piVersion ?? null,
    provider: preflight?.actualProvider ?? null,
    model: preflight?.actualModel ?? null,
    pairedDiscoveryRetention: primaryRetention,
    deferredDiscoveryRate,
    negativeControlLoaderAvoidance: negativeLoaderAvoidance,
    reportedTokenDeltaPct: tokenDeltaPct,
    latencyDeltaPct,
    validCases: metrics.counts.validCases,
    invalidCases: metrics.counts.invalidCases,
  };
  appendFileSync(historyPath, `${JSON.stringify(historyEntry)}\n`, 'utf8');
}

console.log(resolve(runDir, 'comparison.md'));
