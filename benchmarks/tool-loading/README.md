# Tool-loading reliability benchmark

A repeatable A/B benchmark for Pi's normal all-tools exposure versus `pi-token-burden` deferred tool loading.

## What it measures

Primary metric: **paired discovery retention**.

For each task/repetition where baseline Pi used the intended specialist tool, did deferred Pi also discover and use that tool?

Secondary metrics:

- deferred discovery success (`search_tools` -> target tool)
- unnecessary `search_tools` calls on core-tool controls
- provider-reported tokens
- wall-clock latency
- tool-call count

## Benchmark arms

| Arm | Initial active tools |
|---|---|
| Baseline | every registered tool except `search_tools` |
| Deferred | `read`, `bash`, `edit`, `write`, `search_tools` |

Both arms keep the same extensions loaded. The only intended model-facing difference is tool disclosure.

The benchmark uses these process-local overrides so it never rewrites the user's Pi settings:

```text
PI_TOKEN_BURDEN_DEFERRED_TOOLS=0|1
PI_TOKEN_BURDEN_ALWAYS_ACTIVE=read,bash,edit,write
```

## Run with an orchestrator

Point the orchestrator at:

```text
benchmarks/tool-loading/ORCHESTRATOR.md
```

It performs preflight, partitions tasks across runner subagents, runs paired repetitions, builds the comparison, and records the trend summary.

## Manual smoke test

```bash
# 1. Creates a timestamped result directory and verifies both A/B tool sets.
node benchmarks/tool-loading/scripts/probe.mjs

# 2. Use the printed directory for one paired task run.
node benchmarks/tool-loading/scripts/run-pair.mjs \
  --run-dir benchmarks/tool-loading/results/<RUN_ID> \
  --task diagnostics \
  --rep 1

# 3. Build the report.
node benchmarks/tool-loading/scripts/compare.mjs \
  --run-dir benchmarks/tool-loading/results/<RUN_ID>
```

Use `--model <model>` and `--thinking <level>` consistently on preflight and pair runs when you want a pinned configuration.

## Files

```text
benchmark.json        run count, timeout, concurrency, always-active tools
tasks.json            stable capability probes and controls
ORCHESTRATOR.md       autonomous orchestration instructions
inventory-extension.ts preflight-only tool inventory probe
scripts/probe.mjs     verifies benchmark invariants
scripts/run-pair.mjs  runs one baseline/deferred pair
scripts/compare.mjs   aggregates metrics and writes comparison.md
results/              timestamped runs + durable history.jsonl
```

Raw JSON event streams and per-case normalized files are gitignored. Keep `preflight.json`, `metrics.json`, `comparison.md`, and `history.jsonl` if you want durable longitudinal results.

## Probe quality

A positive task is automatically marked **weak** when baseline uses its target tool in less than 60% of valid repetitions. Weak probes are excluded from the overall paired-retention metric, because they do not reliably test the specialist capability even before deferral is introduced.

Optional tasks are skipped when their target tool is not installed. Negative controls always run.
