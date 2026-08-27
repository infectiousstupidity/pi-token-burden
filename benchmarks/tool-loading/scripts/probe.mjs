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
const inventoryPath = resolve(runDir, 'inventory.json');
const piBin = arg('--pi', config.piBin ?? 'pi');
const model = arg('--model', config.model ?? null);
const thinking = arg('--thinking', config.thinking ?? null);
const extensionPath = resolve(benchDir, 'inventory-extension.ts');

const piArgs = ['--mode', 'json', '--no-session', '--approve', '-e', extensionPath];
if (model) {
  piArgs.push('--model', model);
}
if (thinking) {
  piArgs.push('--thinking', thinking);
}
piArgs.push('--', 'Reply exactly OK.');

const startedAt = new Date().toISOString();
const result = await runProcess(piBin, piArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    PI_TOKEN_BURDEN_DEFERRED_TOOLS: '0',
    PI_TOKEN_BURDEN_ALWAYS_ACTIVE: (config.alwaysActive ?? ['read', 'bash', 'edit', 'write']).join(','),
    PI_TOOL_BENCH_INVENTORY_PATH: inventoryPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

writeFileSync(resolve(runDir, 'preflight.stdout.jsonl'), result.stdout, 'utf8');
writeFileSync(resolve(runDir, 'preflight.stderr.log'), result.stderr, 'utf8');

if (result.code !== 0 || !existsSync(inventoryPath)) {
  console.error(`Preflight failed (exit ${String(result.code)}). See ${runDir}`);
  process.exit(result.code || 1);
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const availableNames = new Set(inventory.allTools.map((tool) => tool.name));
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
  startedAt,
  completedAt: new Date().toISOString(),
  repoRoot,
  gitSha: gitSha || null,
  piVersion: piVersion || null,
  requestedModel: model,
  requestedThinking: thinking,
  allToolCount: inventory.allTools.length,
  activeToolCountBaseline: inventory.activeTools.length,
  runnableTasks,
  skippedTasks,
};
writeFileSync(resolve(runDir, 'preflight.json'), JSON.stringify(preflight, null, 2), 'utf8');

console.log(runDir);
console.log(`Runnable tasks: ${runnableTasks.join(', ')}`);
if (skippedTasks.length > 0) {
  console.log(`Skipped: ${skippedTasks.map((task) => task.id).join(', ')}`);
}
