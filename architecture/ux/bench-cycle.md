# UX flow: bench cycle

The user has `config.json` set up and `.gguf` files on disk. They want
benchmark numbers and per-model launchers.

## Goal

From a populated `scan_paths` to `data/report.html` + `data/bats/*.bat`.

## Steps

1. **Discover**:
   ```powershell
   llm-lab discover
   ```
   Recursive glob of `scan_paths` (filtered by `exclude_patterns`). Builds
   `data/catalog.json` with one entry per `.gguf` file: model, series,
   variant, size, tier hint, sibling mmproj if any.

2. **Plan**:
   ```powershell
   llm-lab plan
   ```
   Expands each cataloged model into N test configurations based on its
   tier (Tier A: ctx × KV-quant pairs; Tier B: `--n-cpu-moe` sweep;
   Tier C: `--gpu-layers` sweep). Writes `data/plan.json`.

3. **Bench**:
   ```powershell
   llm-lab bench
   ```
   For each pending config (skips ones with cached `data/results/*.json`):
   - Print warning if backend doesn't match GPU (Vulkan-only on NVIDIA).
   - Spawn `llama-server` with the config's flags.
   - Wait for `/v1/models` to respond, then warm-up call, then real
     `/completion` call. Record `prompt_tps`, `eval_tps`, `vram_peak`,
     `shared_peak`.
   - On `unknown model architecture` error: skip remaining configs of the
     same model.
   - Print one line per config: `[OK] / [FAIL] / [SKIP]` with results or
     reason.
   - At the end: summary table with counts and abandoned families.

4. **Report**:
   ```powershell
   llm-lab report
   ```
   Picks one winner per model (or model+variant if `-GroupBy model+variant`),
   preferring safe (non-paging) configs over fast-but-paging ones. Emits:
   - `data/report.html` — sortable tables, charts, WDDM watchlist.
   - `data/bats/<model>.bat` — double-clickable launcher with the winning
     cmdline and a header reporting the measured numbers.

5. **One-shot**: `llm-lab all` does steps 1-4 in sequence. Add
   `-DownloadSamples` to fetch the curated reference set first.

## Filters

Any of `discover` / `plan` / `bench` / `report` accepts:

- `-Model <regex>` — only models whose name matches.
- `-Tier {A,B,C}` — only the selected tier.
- `-Id <wildcard>` — only configs whose test ID matches (`bench` only).
- `-Force` — re-run cached configs.
- `-DryRun` — list what would happen, don't execute.

## What success looks like

- A bench summary like `64 ok · 4 fail · 22 skipped (out of 90)`.
- `data/report.html` with bar charts of `eval_tps` and `vram_peak`,
  per-model winner cards, and a WDDM watchlist for any saturating
  configs.
- `data/bats/<model>.bat` per winner.

## Reading the report

- **Top of dashboard**: VRAM safety budget chart. Configs at the budget
  line are healthy; configs spilling above are flagged.
- **Bar chart**: `eval_tps` per config. Tall bars = fast.
- **Per-model card**: the winning config's flag string, copy-pasteable
  to a custom `llama-server` invocation.
- **WDDM watchlist**: configs where `shared_peak_mib` exceeded the
  `shared_delta_confirm_mib` threshold or `vram_saturation > 0.92`.
  These are configs you should NOT use even if their `eval_tps` is good.
