# Claude handoff — context load curve and vanilla profile

## Current repository state

- Branch: `dev`
- Last pushed merge: `2a2f74b merge: context load curve profile`
- Feature branch already merged and pushed: `feat/context-load-curve-profile`
- Recent tests passed before merge:
  - `npm test` from `cli/`: 145/145
  - `.\tests\run-tests.ps1`: 16 files passed

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

1. Surface launch profile in Throughput & memory chart rows/tooltips.
2. Add the `context-only-partial-offload` guardrail behavior:
   - context-primary models should get a small empirical offload check when
     vanilla/default behavior beats calibr materially or when full GPU offload
     shows saturation/shared pressure.
3. Implement near-winner refinement:
   - allow configs/models within a tolerance band from the top result to enter
     the next refinement step;
   - needed because a near winner may have better KV/cache scaling later.
4. Implement clearer guided benchmark scopes:
   - baseline;
   - baseline + simple config;
   - baseline + advanced config;
   - baseline + advanced + prefill/KV-fill;
   - full matrix / "folle".
5. Final documentation pass after the policy work:
   - README;
   - HOW-IT-WORKS;
   - METRICS;
   - architecture/domain;
   - architecture/design docs.

## Retest suggestion

For Gemma 4 E4B, regenerate the plan through guided run and rerun:

- local folder;
- model: Gemma 4 E4B;
- load sweep: baseline + prefill + KV-fill;
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
