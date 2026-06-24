# Claude handoff — context load curve and vanilla profile

## Current repository state

- Branch: `dev`
- Last pushed merge: `2a2f74b merge: context load curve profile`
- Feature branch already merged and pushed: `feat/context-load-curve-profile`
- Recent tests passed before merge:
  - `npm test` from `cli/`: 145/145
  - `.\tests\run-tests.ps1`: 16 files passed

## 2026-06-24 update from Codex thread

This handoff was originally written before the latest `dev` state. The current
important pushed merges are:

- `1e8b9d7 merge: vanilla-adjacent speed probes`
- `3760048 merge: benchmark scope policies`

Recent verification:

- after vanilla-adjacent probes:
  - `npm test` from `cli/`: 146/146
  - `.\tests\run-tests.ps1`: 16 files passed
- after benchmark-scope policy UI:
  - `npm test` from `cli/`: 147/147

### Vanilla-adjacent probes now exist, but the UX is not done

The planner now adds diagnostic controls for context-primary models:

```text
llama_cpp_ctx=<N>_default
llama_cpp_ctx=<N>_parallel1
llama_cpp_ctx=<N>_parallel1_kv=<type>
```

They are `control_kind = vanilla-adjacent`, excluded from winner selection and
launcher generation. Their purpose is to explain why vanilla may beat a
calibrated config: default context behavior, auto-parallelism, KV-cache
precision, or calibr's remaining base runtime flags.

Important: after the first Gemma E4B retest, the user judged the current table
presentation as "complete no sense". The data is useful, but dumping the
vanilla-adjacent probe rows into the same drilldown/table as normal configs
creates visual noise and makes the product story harder to read.

Required UX follow-up:

1. Keep vanilla-adjacent rows available for audit/logs.
2. Do not present them as ordinary baseline candidates in the main drilldown.
3. Add a compact comparison visualization instead:
   - radar/star chart or small baseline profile chart;
   - sequence: `vanilla -> ctx-only -> parallel1 -> parallel1+KV -> calibr`;
   - show deltas for eval, prompt, VRAM, shared, power/efficiency if present.
4. Use it to explain the "why is vanilla faster?" case, not to pick winners.

This is now one of the most important UX gaps because otherwise the controls
look like random extra configs.

### Benchmark scope policy first layer is implemented

Guided run now exposes `benchmark scope` instead of raw `load sweep`:

```text
baseline
baseline + prefill/KV load curves
exhaustive (load curves + full speed curve)
```

Mapping in `cli/src/AllOptionsView.tsx`:

- `baseline` -> `WorkloadSweep baseline`
- `load-curves` -> `WorkloadSweep all`
- `exhaustive` -> `WorkloadSweep all` + `-FullSpeedCurve`

This is only the first layer. It clarifies user intent and prevents
`-FullSpeedCurve` from being an obscure advanced toggle, but it does **not yet**
implement the originally desired full scope matrix:

- baseline;
- baseline + simple config;
- baseline + advanced config;
- baseline + advanced + prefill/KV-fill;
- full matrix / "folle".

The missing piece is planner density: deciding how many context/offload/MoE/KV
candidates each scope should generate. Do not assume the UX label already means
the planner is doing different simple-vs-advanced density.

## What changed most recently

The latest change addressed an incorrect diagnostic workload shape for
high-context models.

Before:

- prefill targets were fixed small values such as `512`, `2048`, `8192`,
  `32768`;
- KV-fill was ratio-based;
- on a 131K context this made the prefill curve look arbitrary and too small
  at the beginning.

Now:

- prefill uses one micro target (`2048`) plus context-relative ratios:
  `25%`, `50%`, `75%`, `90%`;
- KV-fill uses the same ratios;
- target generation still respects:

```text
target <= context size - context reserve - generated tokens
```

For a 131K context this should produce approximately:

- prefill: `2048`, `32768`, `65536`, `98304`, `117964`
- KV-fill: `32768`, `65536`, `98304`, `117964`

## Vanilla control clarification

The vanilla control is intentionally launched without calibr tuning flags.
It receives:

- model path;
- mmproj path when present;
- benchmark harness necessities such as port/host/no-warmup/cache-ram/slot path.

It does **not** receive calibr's:

- `--ctx-size`;
- `--cache-type-k/v`;
- `--gpu-layers`;
- `--parallel`;
- batch/thread policy;
- MoE/offload policy;
- `--fit off`.

This means vanilla throughput is not a same-profile comparison against a
calibr config. It is a "llama.cpp defaults" control. The report must make this
visible, otherwise a line like "vanilla 56 t/s vs calibr 50 t/s" is misleading.

The recent change added result fields for requested/effective launch profile:

- `requested_context_size`
- `requested_cache_type_k`
- `requested_cache_type_v`
- `requested_gpu_layers`
- `requested_n_cpu_moe`
- `requested_parallel`
- `effective_context_size`
- `effective_parallel_slots`
- `effective_n_parallel`
- `flash_attention_state`

`effective_*` values are parsed from llama-server logs when present. Real
example from older Qwen logs: vanilla used `n_parallel = 4`, `n_ctx = 4096`
per slot while calibr measured configs used explicit long context and
`--parallel 1`.

## Important UX gap still open

The launch profile is now present in:

- model drilldown table in `report.template.html`;
- result detail view in `cli/src/ResultsView.tsx`;
- result JSON fields.

But it is **not yet visible in the "Throughput & memory" bar widget** shown in
the latest screenshot. That widget still uses compact labels like:

```text
gemma-4-E4B-it Q4_K_M @ vanilla_llama_cpp
```

So the user still cannot see the vanilla profile directly from that chart.

Recommended next small fix:

1. Update the Throughput & memory bar row tooltip/annotation to include
   `launchProfileLabel(d)` / `launchProfileTitle(d)`.
2. For vanilla rows, show something compact such as:

```text
vanilla · requested defaults · effective ctx 4096 · slots 4 · layers X/Y
```

3. For calibrated rows, show:

```text
ctx 131K · q8/q8 · gpu-layers 99 · effective ctx 131K · slots 1
```

Do not invent cache or context for vanilla if not present. Use `default` or
`unknown` unless the log parser produced an effective value.

## User-visible interpretation to preserve

The user's preferred mental model:

- vanilla should be shown as:

```text
vanilla 55 t/s, ctx/default-or-effective, cache/default, offload X layers
calibr 45 t/s, ctx 65K/131K, q8/q8, gpu-layers 99
```

- prefill/KV-fill should be understood as a per-config load curve, not as
  separate winner candidates;
- the eventual UX should let a user click a model/config and see a small curve
  showing how prompt/eval changes at 25/50/75/90% load, ideally with a vertical
  memory-cliff/shared-memory marker.

## Domain naming agreed with user

Use these semantic names in docs/new code:

- `moe-cpu`
- `offload-dense`
- `context-only`
- `context-only-partial-offload`

Legacy result JSONs and some code still use `context` and `offload`. Treat them
as aliases for `context-only` and `offload-dense` unless doing a dedicated
migration.

## Remaining queued work

1. Separate vanilla-adjacent controls from ordinary result rows:
   - keep them in raw results and logs;
   - hide/collapse them from the main model drilldown by default;
   - add a radar/star/baseline-delta chart showing the sequence
     `vanilla -> ctx-only -> parallel1 -> parallel1+KV -> calibr`;
   - show why calibr/vanilla differ instead of making the table noisier.
2. Surface launch profile in Throughput & memory chart rows/tooltips:
   - this is still open for report widgets outside the detailed table;
   - use `requested_*` and `effective_*` fields already present in results;
   - show `default` / `unknown` rather than inventing missing values.
3. Implement true benchmark-scope planner density:
   - current UI maps scope to workload/full-curve only;
   - still missing: baseline/simple/advanced/advanced+load/full-matrix
     config-count differences;
   - before run, show model count, config count, measured run count, estimated
     duration, total transfer, and peak disk working set.
4. Add the `context-only-partial-offload` guardrail behavior:
   - context-primary models should get a small empirical offload check when
     vanilla/default behavior beats calibr materially or when full GPU offload
     shows saturation/shared pressure.
5. Implement near-winner refinement:
   - allow configs/models within a tolerance band from the top result to enter
     the next refinement step;
   - needed because a near winner may have better KV/cache scaling later.
6. Runtime error decision tree:
   - architecture/design/runtime-failure-policy.md exists and should remain
     the reference;
   - continue moving generic `server didn't become ready` into structured
     causes/actions;
   - retry same config for ambiguous transient errors;
   - same-context KV rescue only for direct capacity/profile-fit failure;
   - prune larger diagnostic targets after repeated diagnostic failures.
7. Spill-risk semantics and UI:
   - memory growth alone is risk, not proof;
   - dense model + significant shared growth without KV-fill should read
     "might spill with high context usage";
   - confirmed spill requires workload evidence: KV-fill crossing the estimated
     cliff plus significant eval degradation;
   - MoE shared allocation remains ambiguous unless a dedicated policy proves
     otherwise.
8. Persistent Node benchmark/job direction:
   - user wants to move away from PowerShell orchestration long-term;
   - desired UX: benchmark can keep running if UI freezes/closes, with tray
     indicator/reconnect later;
   - do not implement a new backend/web phase yet, but keep this direction in
     mind when touching long-running workflow boundaries.
9. Final documentation pass after the policy work:
   - README;
   - HOW-IT-WORKS;
   - METRICS;
   - architecture/domain;
   - architecture/design docs.

## Retest suggestion

For Gemma 4 E4B, regenerate the plan through guided run and rerun:

- local folder;
- model: Gemma 4 E4B;
- benchmark scope: baseline + prefill/KV load curves;
- default settings.

Expected diagnostic targets at ctx 131072:

- `prefill=2048`
- `prefill=32768`
- `prefill=65536`
- `prefill=98304`
- `prefill=117964`
- `kvfill=32768`
- `kvfill=65536`
- `kvfill=98304`
- `kvfill=117964`

If the report screenshot still shows only labels in Throughput & memory, that
is expected until the UX gap above is fixed.
