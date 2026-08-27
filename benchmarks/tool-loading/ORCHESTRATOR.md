# Tool-loading reliability benchmark orchestrator

You are the benchmark orchestrator. Run the benchmark end to end, delegate independent task batches to subagents, then return one compact comparison to the user.

## Goal

Compare two otherwise-identical Pi configurations:

- **Baseline:** native-equivalent Pi tool exposure. Every registered tool is active except `search_tools`.
- **Deferred:** only `read`, `bash`, `edit`, `write`, and `search_tools` start active. Specialist tools must be discovered and activated on demand.

The primary question is:

> When baseline Pi naturally uses the intended specialist tool, how often does deferred Pi still discover and use it?

Do not change task prompts between arms.

## Ground rules

- Use the same model, thinking level, cwd, installed extensions, context files, and task prompt for both arms.
- Every case is a fresh `--no-session` Pi run.
- The benchmark uses process-local environment overrides; do not edit the user's Pi settings.
- Each repetition alternates A/B order automatically to reduce order/cache bias.
- Never selectively retry only the worse arm. Infrastructure failures stay recorded and are excluded from valid-case metrics.
- Do not modify benchmark tasks during a run.
- Do not let runner subagents edit source files.

## 1. Preflight

From the repository root run:

```bash
node benchmarks/tool-loading/scripts/probe.mjs
```

If the user specified a model/thinking level, pin them:

```bash
node benchmarks/tool-loading/scripts/probe.mjs --model <model> --thinking <level>
```

The command prints a run directory. Save it as `RUN_DIR`.

Read `RUN_DIR/preflight.json`.

Stop if `ok` is false. This means the installed Pi/token-burden combination is not actually producing the expected baseline/deferred active-tool sets. Report the failed invariant instead of running a misleading benchmark.

Use only `runnableTasks`. Missing optional specialist tools are normal and must be reported as skipped.

## 2. Spawn runner subagents

Read `benchmark.json` for `repetitions` and `maxParallelAgents`.

Partition `runnableTasks` across at most `maxParallelAgents` runner subagents. Give each subagent whole task IDs so one subagent owns all repetitions for a task.

Each runner subagent executes, for every assigned task and repetition:

```bash
node benchmarks/tool-loading/scripts/run-pair.mjs \
  --run-dir <RUN_DIR> \
  --task <TASK_ID> \
  --rep <N>
```

Pass the exact same `--model` and `--thinking` values used during preflight when they were explicitly pinned.

A runner must:

1. Run every assigned repetition exactly once.
2. Leave failed/time-out cases in place; do not cherry-pick retries.
3. Report only command failures and completion status to the orchestrator.
4. Never interpret results while other runners are still working.

## 3. Validate completion

After all runners return, verify each runnable task has both baseline and deferred case files for the configured repetition count under:

```text
RUN_DIR/cases/{baseline,deferred}/<task>/
```

If files are missing, run only the missing **pair**, not a single arm.

## 4. Compare objectively

Run:

```bash
node benchmarks/tool-loading/scripts/compare.mjs --run-dir <RUN_DIR> --record
```

This creates:

- `RUN_DIR/metrics.json` - machine-readable metrics
- `RUN_DIR/comparison.md` - human-readable comparison
- `benchmarks/tool-loading/results/history.jsonl` - one durable summary row for trend comparison

Raw traces and per-case JSON are intentionally gitignored; the compact result artifacts are suitable for keeping over time.

## 5. Spawn one analysis subagent

Give the analysis subagent only:

- `RUN_DIR/preflight.json`
- `RUN_DIR/metrics.json`
- `RUN_DIR/comparison.md`
- `benchmarks/tool-loading/results/history.jsonl` if it exists

Ask it to check for obvious anomalies and compare this run with previous recorded runs. It may inspect raw traces only for anomalous tasks.

It must not invent a composite score. The main reliability number is `pairedDiscoveryRetention`.

## 6. Final response

Return a compact report with exactly these points:

- **Reliability:** paired discovery retention.
- **Discovery:** deferred discovery success rate.
- **Discipline:** negative-control loader avoidance.
- **Cost:** reported token delta and latency delta.
- **Problems:** weak probes, skipped tools, failed cases, or regressions versus history.
- **Artifacts:** the run directory and `comparison.md` path.

Interpretation:

- Near-100% paired discovery retention means deferred loading preserved specialist-tool selection when baseline wanted that tool.
- A weak probe means baseline itself rarely used the target tool; do not blame deferred loading for that task.
- Negative controls should almost never call `search_tools`.
- Token/latency savings matter only after reliability is acceptable.
