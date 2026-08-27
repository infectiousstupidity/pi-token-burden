#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(scriptDir, '..');
const repoRoot = resolve(benchDir, '../..');
const config = JSON.parse(readFileSync(resolve(benchDir, 'benchmark.json'), 'utf8'));
const taskList = JSON.parse(readFileSync(resolve(benchDir, 'tasks.json'), 'utf8')).tasks;
const WINDOWS_SHELL = process.platform === 'win32';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function safeName(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
}

function parseJsonLines(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Keep malformed/non-JSON output in the raw file; ignore it for metrics.
    }
  }
  return events;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('\n')
    .trim();
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (typeof usage[key] === 'number') total[key] += usage[key];
  }
  if (usage.cost && typeof usage.cost.total === 'number') {
    total.cost += usage.cost.total;
  }
}

function extractActivated(result) {
  const details = result?.details;
  if (details && Array.isArray(details.activated)) {
    return details.activated.filter((name) => typeof name === 'string');
  }

  const content = result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = item?.text;
      if (typeof text !== 'string' || !text.startsWith('Activated:')) continue;
      return text
        .slice('Activated:'.length)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function analyze(events, task) {
  const toolCalls = [];
  const searchActivations = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let finalText = '';
  let provider = null;
  let model = null;

  for (const event of events) {
    if (event?.type === 'tool_execution_start' && typeof event.toolName === 'string') {
      toolCalls.push({ name: event.toolName, args: event.args ?? null });
    }
    if (event?.type === 'tool_execution_end' && event.toolName === 'search_tools') {
      searchActivations.push(...extractActivated(event.result));
    }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      addUsage(usage, event.message.usage);
      const text = textFromContent(event.message.content);
      if (text) finalText = text;
      if (typeof event.message.provider === 'string') provider = event.message.provider;
      if (typeof event.message.responseModel === 'string') model = event.message.responseModel;
      else if (typeof event.message.model === 'string') model = event.message.model;
    }
  }

  const names = toolCalls.map((call) => call.name);
  const targetHit = task.targetTools.some((target) => names.includes(target));
  const searchCalls = names.filter((name) => name === 'search_tools').length;
  const targetCallIndex = names.findIndex((name) => task.targetTools.includes(name));
  const firstSearchIndex = names.indexOf('search_tools');

  return {
    toolCalls,
    searchCalls,
    searchQueries: toolCalls
      .filter((call) => call.name === 'search_tools')
      .map((call) => call.args?.query)
      .filter((query) => typeof query === 'string'),
    activatedTools: [...new Set(searchActivations)],
    targetHit,
    targetCallIndex,
    loaderBeforeTarget:
      targetCallIndex >= 0 && firstSearchIndex >= 0 && firstSearchIndex < targetCallIndex,
    negativeControlPass: task.kind === 'negative' ? searchCalls === 0 : null,
    finalText,
    usage,
    provider,
    model,
  };
}

function runProcess(command, args, options, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, { ...options, shell: WINDOWS_SHELL });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      stderr += `${error.message}\n`;
      finish({ code: null, signal: null, stdout, stderr, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runOne({ mode, task, repetition, runDir, piBin, model, thinking, cwd }) {
  const rawDir = resolve(runDir, 'raw', mode, safeName(task.id));
  const caseDir = resolve(runDir, 'cases', mode, safeName(task.id));
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(caseDir, { recursive: true });

  const args = ['--mode', 'json', '--no-session', '--approve'];
  if (model) args.push('--model', model);
  if (thinking) args.push('--thinking', thinking);
  args.push('--', task.prompt);

  const env = {
    ...process.env,
    PI_TOKEN_BURDEN_DEFERRED_TOOLS: mode === 'deferred' ? '1' : '0',
    PI_TOKEN_BURDEN_ALWAYS_ACTIVE: (config.alwaysActive ?? ['read', 'bash', 'edit', 'write']).join(','),
  };

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await runProcess(
    piBin,
    args,
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    config.timeoutMs ?? 300000,
  );
  const durationMs = Date.now() - started;

  const stem = String(repetition).padStart(2, '0');
  const stdoutPath = resolve(rawDir, `${stem}.jsonl`);
  const stderrPath = resolve(rawDir, `${stem}.stderr.log`);
  writeFileSync(stdoutPath, result.stdout, 'utf8');
  writeFileSync(stderrPath, result.stderr, 'utf8');

  const events = parseJsonLines(result.stdout);
  const analysis = analyze(events, task);
  const caseResult = {
    version: 1,
    taskId: task.id,
    taskKind: task.kind,
    targetTools: task.targetTools,
    mode,
    repetition,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    command: [piBin, ...args],
    rawStdout: stdoutPath,
    rawStderr: stderrPath,
    ...analysis,
  };

  const casePath = resolve(caseDir, `${stem}.json`);
  writeFileSync(casePath, JSON.stringify(caseResult, null, 2), 'utf8');
  return caseResult;
}

const taskId = arg('--task');
if (!taskId) {
  console.error('Usage: node run-pair.mjs --run-dir <dir> --task <id> --rep <n> [--model <model>]');
  process.exit(2);
}

const task = taskList.find((candidate) => candidate.id === taskId);
if (!task) {
  console.error(`Unknown task: ${taskId}`);
  process.exit(2);
}

const repetition = Number(arg('--rep', '1'));
if (!Number.isInteger(repetition) || repetition < 1) {
  console.error('--rep must be an integer >= 1');
  process.exit(2);
}

const runDirArg = arg('--run-dir');
if (!runDirArg) {
  console.error('--run-dir is required; use the directory printed by probe.mjs');
  process.exit(2);
}

const runDir = resolve(runDirArg);
const piBin = arg('--pi', config.piBin ?? 'pi');
const model = arg('--model', config.model ?? null);
const thinking = arg('--thinking', config.thinking ?? null);
const cwd = resolve(arg('--cwd', repoRoot));
const order = repetition % 2 === 1 ? ['baseline', 'deferred'] : ['deferred', 'baseline'];

for (const mode of order) {
  const result = await runOne({ mode, task, repetition, runDir, piBin, model, thinking, cwd });
  console.log(
    `${task.id} rep ${String(repetition)} ${mode}: exit=${String(result.exitCode)} target=${String(result.targetHit)} search=${String(result.searchCalls)} ${String(result.durationMs)}ms`,
  );
  if (result.exitCode !== 0 || result.timedOut) {
    process.exitCode = 1;
  }
}
