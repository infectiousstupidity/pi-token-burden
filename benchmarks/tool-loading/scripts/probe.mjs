#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(scriptDir, '..');
const repoRoot = resolve(benchDir, '../..');
const configPath = resolve(benchDir, 'benchmark.json');
const tasksPath = resolve(benchDir, 'tasks.json');
const configText = readFileSync(configPath, 'utf8');
const tasksText = readFileSync(tasksPath, 'utf8');
const config = JSON.parse(configText);
const tasks = JSON.parse(tasksText).tasks;
const WINDOWS_SHELL = process.platform === 'win32';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function runIdNow() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractRuntime(stdout) {
  let provider = null;
  let model = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'message_end' || event.message?.role !== 'assistant') continue;
    if (typeof event.message.provider === 'string') provider = event.message.provider;
    if (typeof event.message.responseModel === 'string') model = event.message.responseModel;
    else if (typeof event.message.model === 'string') model = event.message.model;
  }
  return { provider, model };
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
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
      child.kill('SIGTERM');
    }, config.timeoutMs ?? 300000);

    child.on('error', (error) => {
      clearTimeout(timer);
      stderr += `${error.message}\n`;
      finish({ code: null, signal: null, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout, stderr });
    });
  });
}

const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout?.trim();
const gitStatus = spawnSync('git', ['status', '--porcelain=v1'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout ?? '';
const gitDiff = spawnSync('git', ['diff', '--binary', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout ?? '';

const runDir = resolve(arg('--run-dir', resolve(benchDir, 'results', runIdNow())));
mkdirSync(runDir, { recursive: true });
const piBin = arg('--pi', config.piBin ?? 'pi');
const model = arg('--model', config.model ?? null);
const thinking = arg('--thinking', config.thinking ?? null);
const extensionPath = resolve(benchDir, 'inventory-extension.ts');
const alwaysActive = config.alwaysActive ?? ['read', 'bash', 'edit', 'write'];

const piArgs = ['--mode', 'json', '--no-session', '--approve', '-e', extensionPath];
if (model) {
  piArgs.push('--model', model);
}
if (thinking) {
  piArgs.push('--thinking', thinking);
}
piArgs.push('--', 'Reply exactly OK.');

async function probeMode(mode) {
  const inventoryPath = resolve(runDir, `inventory-${mode}.json`);
  const result = await runProcess(piBin, piArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_TOKEN_BURDEN_DEFERRED_TOOLS: mode === 'deferred' ? '1' : '0',
      PI_TOKEN_BURDEN_ALWAYS_ACTIVE: alwaysActive.join(','),
      PI_TOOL_BENCH_INVENTORY_PATH: inventoryPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  writeFileSync(resolve(runDir, `preflight-${mode}.stdout.jsonl`), result.stdout, 'utf8');
  writeFileSync(resolve(runDir, `preflight-${mode}.stderr.log`), result.stderr, 'utf8');

  if (result.code !== 0 || !existsSync(inventoryPath)) {
    throw new Error(`${mode} probe failed (exit ${String(result.code)})`);
  }
  return {
    inventory: JSON.parse(readFileSync(inventoryPath, 'utf8')),
    runtime: extractRuntime(result.stdout),
  };
}

const startedAt = new Date().toISOString();
let baselineProbe;
let deferredProbe;
try {
  baselineProbe = await probeMode('baseline');
  deferredProbe = await probeMode('deferred');
} catch (error) {
  console.error(`Preflight failed: ${error instanceof Error ? error.message : String(error)}. See ${runDir}`);
  process.exit(1);
}

const baselineAll = baselineProbe.inventory.allTools.map((tool) => tool.name).toSorted();
const deferredAll = deferredProbe.inventory.allTools.map((tool) => tool.name).toSorted();
const baselineActive = baselineProbe.inventory.activeTools.toSorted();
const deferredActive = deferredProbe.inventory.activeTools.toSorted();
const expectedDeferred = [
  'search_tools',
  ...alwaysActive.filter((name) => deferredAll.includes(name)),
].filter((name, index, values) => values.indexOf(name) === index).toSorted();
const expectedBaseline = baselineAll.filter((name) => name !== 'search_tools');

const invariants = {
  sameToolCatalog: JSON.stringify(baselineAll) === JSON.stringify(deferredAll),
  searchToolRegistered: baselineAll.includes('search_tools'),
  baselineHasAllNonLoaderTools: JSON.stringify(baselineActive) === JSON.stringify(expectedBaseline),
  deferredHasOnlyCorePlusLoader: JSON.stringify(deferredActive) === JSON.stringify(expectedDeferred),
  sameProvider: baselineProbe.runtime.provider === deferredProbe.runtime.provider,
  sameModel: baselineProbe.runtime.model === deferredProbe.runtime.model,
};
const preflightOk = Object.values(invariants).every(Boolean);

const availableNames = new Set(baselineAll);
const runnableTasks = [];
const skippedTasks = [];
for (const task of tasks) {
  if (task.kind === 'negative' || task.targetTools.some((name) => availableNames.has(name))) {
    runnableTasks.push(task.id);
  } else {
    skippedTasks.push({
      id: task.id,
      reason: `No target tool available: ${task.targetTools.join(', ')}`,
      optional: task.optional,
    });
  }
}

const piVersion = spawnSync(piBin, ['--version'], {
  encoding: 'utf8',
  shell: WINDOWS_SHELL,
}).stdout?.trim();

const preflight = {
  version: 1,
  ok: preflightOk,
  startedAt,
  completedAt: new Date().toISOString(),
  repoRoot,
  gitSha: gitSha || null,
  gitDirty: gitStatus.trim().length > 0,
  gitDiffSha256: gitDiff ? sha256(gitDiff) : null,
  taskSuiteSha256: sha256(tasksText),
  benchmarkConfigSha256: sha256(configText),
  piVersion: piVersion || null,
  requestedModel: model,
  requestedThinking: thinking,
  actualProvider: baselineProbe.runtime.provider,
  actualModel: baselineProbe.runtime.model,
  alwaysActive,
  invariants,
  allToolCount: baselineAll.length,
  baselineActiveTools: baselineActive,
  deferredActiveTools: deferredActive,
  runnableTasks,
  skippedTasks,
};
writeFileSync(resolve(runDir, 'preflight.json'), JSON.stringify(preflight, null, 2), 'utf8');

console.log(runDir);
console.log(`Model: ${preflight.actualProvider ?? 'unknown'}/${preflight.actualModel ?? 'unknown'}`);
console.log(`Runnable tasks: ${runnableTasks.join(', ')}`);
if (skippedTasks.length > 0) {
  console.log(`Skipped: ${skippedTasks.map((task) => task.id).join(', ')}`);
}
if (!preflightOk) {
  console.error(`Preflight invariants failed: ${JSON.stringify(invariants)}`);
  process.exit(1);
}
