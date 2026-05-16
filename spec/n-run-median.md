# Spec: N-run median for variance reduction

## Goal

Cut variance on the noisy bench metrics by running each
configuration N times (default three) and recording the median for
each metric that drifts run-to-run, plus the raw per-run values
for audit.

## Background

The current single-run bench reports ±5 % variance on `eval_tps`
and ±10 % on `prompt_tps` on a quiet desktop. That resolution is
fine for spotting a four-times speedup but blind to a five-percent
regression. Median of N=3 is the smallest practical reduction; a
larger N trades wall-clock for tighter bounds and is configurable.

The rest of the pipeline (planning, winner picker, report,
launcher generation) keeps consuming the same top-level fields it
reads today. Only `bench` changes, and only by writing more data.

## Behavior

### Configuration

- New field in `config.default.json`:

  ```json
  "bench": {
    ...
    "runs_per_config": 3
  }
  ```

- Type: integer, minimum one. `bench.runs_per_config: 1` reproduces
  exactly the current behavior (no median taken; the single run
  is the result).

### CLI flag

- New flag on `bench`, `all`: `-Runs <int>`. Overrides the config
  value for this invocation. `-Runs 1` is a valid escape hatch.

### Execution order

- For each test id, all N runs are executed in immediate
  succession before moving to the next test id. No interleaving
  with other configs (warm-state matters; we want the N runs to
  see consistent driver state).
- Each run inside the loop is the full warmup-then-bench cycle
  currently in `Invoke-OneBench`. The warmup is preserved on every
  run; eight tokens of warmup take well under a second and the
  cost is dominated by the bench step itself.

### Result file shape

- `data/results/{TestID}.json` gains a `runs` array. Each entry
  records every numeric field that the single-run bench captures
  today, plus a `run_index` (zero-based).

  ```json
  "runs": [
    { "run_index": 0, "prompt_per_second": 412.1, ... },
    { "run_index": 1, "prompt_per_second": 398.7, ... },
    { "run_index": 2, "prompt_per_second": 405.3, ... }
  ]
  ```

- Top-level fields carry the **median** over `runs` for the
  varying metrics, listed exhaustively:
  - `prompt_per_second`
  - `predicted_per_second`
  - `vram_peak_mib`
  - `shared_peak_mib`
  - `wddm_vram_saturation`
  - `time_total_sec`
  - `headroom_mib`
- Top-level fields for the deterministic metrics carry the value
  from `runs[0]` unchanged:
  - `ctx_size`
  - `model_buffer_size_mib`
  - `kv_buffer_size_mib`
  - `compute_buffer_size_mib`
- Median definition: for N odd, the middle value after sorting;
  for N even, the lower of the two middle values (no averaging).
  Documented in the spec; implemented in one helper.

### Cache invalidation

- When `bench` finds an existing `data/results/{TestID}.json`
  whose `runs` array has a length different from the requested N
  (whether shorter or longer), the file is treated as invalid and
  all N runs re-execute. No append, no truncate, no merge.
- A pre-N-run-median result file (no `runs` array at all) is
  treated as length-zero and re-executes.
- `-Force` retains its existing meaning (re-run even if a
  length-matching result exists).

### Failure handling

- A result file is only written after all N runs complete
  successfully. Partial state (one out of three runs done, the
  process killed) is not persisted. The next bench call sees no
  file and re-runs all N.
- If any individual run fails (llama-server crash, timeout, OOM),
  the whole test id is marked failed in the existing way; no
  median is computed; no `runs` array is partially written.

### Report and `.bat` launcher

- Both consume the top-level (median) values exactly as today.
  The new `runs` array is available in `data/results/*.json` for
  users who want to audit variance, but the v1.1.0 report does
  not surface it in the UI.

## Acceptance

- [ ] With `bench.runs_per_config: 3`, a fresh `calibr bench`
      writes a `runs` array of length three in each result JSON
      and the top-level varying fields equal the median of the
      corresponding `runs[*]` values.
- [ ] Top-level deterministic fields equal `runs[0]` exactly.
- [ ] `-Runs 1` produces results with a `runs` array of length
      one and top-level fields equal to `runs[0]`. Report and
      `.bat` generation work unchanged.
- [ ] An existing pre-N-run-median result file (no `runs`
      array) re-runs all N when the user requests `-Runs 3`.
- [ ] An existing N=3 result file: a subsequent `-Runs 3` skips
      it (cache hit); a subsequent `-Runs 5` invalidates and
      re-runs all five.
- [ ] An interrupted N=3 bench (process killed after two runs)
      leaves no result file on disk; the next bench call re-runs
      all three.
- [ ] `Config.Tests.ps1` gains a row asserting `runs_per_config`
      round-trips through `config get / set / unset`.
- [ ] `Helpers.Tests.ps1` gains a row asserting the median helper
      handles N=1 (returns the single value), N=3 odd (returns
      the middle), and N=4 even (returns the lower middle).

## Out of scope

- Median absolute deviation, standard deviation, or any spread
  metric beyond the median itself. The raw `runs` array enables a
  user to compute these by hand; a built-in spread field is v1.4.0
  or later territory.
- Adaptive N (run until variance below threshold). Fixed N keeps
  bench wall-time predictable; adaptive is over-engineering for
  the current need.
- Parallel execution of the N runs (single-GPU plus the WDDM
  detection heuristic both require serial execution).
- Per-run log retention beyond what `Invoke-OneBench` already
  writes. The `runs` array captures the numeric fields; per-run
  stderr is not multiplied N times.
- UI changes in the report to expose the raw `runs` array. Audit
  users go to the JSON directly.
