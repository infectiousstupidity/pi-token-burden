#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(scriptDir, '..');
const repoRoot = resolve(benchDir, '../..');
const config = JSON.parse(readFileSync(resolve(benchDir, 'benchmark.json'), 'utf8'));
const tasks = JSON.parse(readFileSync(resolve(benchDir, 'tasks.json'), 'utf8')).tasks;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function runIdNow() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, config.timeoutMs ?? 300000);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

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
  return JSON.parse(readFileSync(inventoryPath, 'utf8'));
}

const startedAt = new Date().toISOString();
let baselineInventory;
let deferredInventory;
try {
  baselineInventory = await probeMode('baseline');
  deferredInventory = await probeMode('deferred');
} catch (error) {
  console.error(`Preflight failed: ${error instanceof Error ? error.message : String(error)}. See ${runDir}`);
  process.exit(1);
}

const baselineAll = baselineInventory.allTools.map((tool) => tool.name).toSorted();
const deferredAll = deferredInventory.allTools.map((tool) => tool.name).toSorted();
const baselineActive = baselineInventory.activeTools.toSorted();
const deferredActive = deferredInventory.activeTools.toSorted();
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

const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout?.trim();
const piVersion = spawnSync(piBin, ['--version'], { encoding: 'utf8' }).stdout?.trim();

const preflight = {
  version: 1,
  ok: preflightOk,
  startedAt,
  completedAt: new Date().toISOString(),
  repoRoot,
  gitSha: gitSha || null,
  piVersion: piVersion || null,
  requestedModel: model,
  requestedThinking: thinking,
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
console.log(`Runnable tasks: ${runnableTasks.join(', ')}`);
if (skippedTasks.length > 0) {
  console.log(`Skipped: ${skippedTasks.map((task) => task.id).join(', ')}`);
}
if (!preflightOk) {
  console.error(`Preflight invariants failed: ${JSON.stringify(invariants)}`);
  process.exit(1);
}
