# calibr — open points

Operational TODO captured at the end of the v0.1.x feature-push session.
Nothing here is blocking; the CLI on `feat/v1.1-quick-wins` is shippable
as-is. This file is the queue for what we picked up next.

Items are grouped by *kind of work*, not strict priority. Within each
group the rough order is "smaller / more isolated first".

---

## Engine + CLI: deferred but designed

### Phase F — report UI redesign
**Shipped.** See `report.template.html` + the `Phase F` markers in
`tests/Report.Tests.ps1`. Visual demo: `node tests/generate-demo-report.mjs`
writes `report_ui/demo-report.html` from synthetic data. What landed:

- Memory-vs-latency scatter is the first visible chart.
- Filter selector at the top picks the winner criterion: speed /
  efficiency / safety-balanced / overall-weighted (the embryo of
  scoring profiles — item 10 expands it to configurable weights).
- Models list is a collapsible `<details>` per model: collapsed row =
  winning config for the current filter; expand = all configs for the
  model with the winner highlighted.
- Eval-tokens-per-second and VRAM-peak bars are tabs of one widget.
- Client-side `.bat` generation for any config (the engine still
  pre-generates one per model in `data/bats/` for the safety-first
  winner).
- Engine serializes the extended metrics (`ttft_sec`,
  `gpu_power_peak_w`, etc.) and `model_path` / `mmproj_path` into the
  report JSON so the efficiency scorer and the bat generator work.

### llama.cpp auto-fetch
*Estimate: 0.5-1d.*

Currently `init` requires the user to have llama-server.exe installed.
On a fresh machine `init` walks `PATH` + sibling folders and either
finds it or asks the user to point at it. The user wants `calibr` to
*fetch llama.cpp itself* from the upstream releases:

- `https://github.com/ggml-org/llama.cpp/releases/download/<bN>/llama-<bN>-bin-win-cuda-<x>.<y>-x64.zip`
- `https://github.com/ggml-org/llama.cpp/releases/download/<bN>/cudart-llama-bin-win-cuda-<x>.<y>-x64.zip` (only if CUDA build)

Steps:

1. Detect hardware (already done in `Get-DetectedHardware`).
2. Pick the right build flavor: CUDA if NVIDIA GPU present, Vulkan or
   ROCm if AMD, CPU-only as fallback. **CUDA version must match the
   driver** — see compat note below.
3. Resolve the latest build tag from the GitHub releases API (or
   accept a config-pinned `bN`).
4. Download into `~/AppData/Local/calibr/llama-bin/<bN>/`. Unzip there.
   For CUDA, also fetch + unzip cudart into the same dir.
5. Point `llama_server_exe` at the new path; persist in `config.json`.

UX-wise, this means `init` no longer fails when llama isn't installed —
it offers to fetch it. Add a confirmation prompt in interactive mode
(`Download ~250 MB from GitHub? y/N`), bypassable with `-AutoFetchLlama`
flag for headless setups.

**CUDA build picker rules (load-bearing — silently picking the wrong
CUDA variant bricks every bench with a PTX toolchain error):**

| llama.cpp build | CUDA in zip name | Min Windows driver |
|-----------------|------------------|--------------------|
| any             | cuda-12.4        | ~R535+             |
| any             | cuda-13.0        | R580+              |
| any             | cuda-13.1        | R590+              |
| any             | cuda-13.3        | R598+              |
| any             | cpu              | (n/a)              |
| any             | vulkan           | (n/a)              |

The numbers above are empirical (R596.21 on RTX 2070 ran b9360 cuda-13.1
cleanly but failed b9482 cuda-13.3 with `PTX was compiled with an
unsupported toolchain` in `ggml_cuda_kernel_can_use_pdl`). Probe with
`nvidia-smi --query-gpu=driver_version --format=csv,noheader` and pick
the highest CUDA variant whose minimum is `<= driver`. Cuda-12.4 is the
safe default for anything R535+. The README's Requirements section
holds the same table for users who set up manually.

### reasoning_mode wiring
*Estimate: 1-2h.*

`models_catalog.json` already carries `reasoning_mode: off` on the
Qwen3 entry, but `Invoke-OneBenchRun` does not pass anything through to
llama-server. Needs:

1. Verify whether current llama.cpp supports `enable_thinking: false` in
   the chat-completion request body, or `--reasoning off` as a startup
   flag. (Last checked when Qwen3 first dropped — may have changed.)
2. Thread the catalog entry's `reasoning_mode` into the bench item via
   `Get-ModelMetadata` / `New-PlanItem`.
3. Modify the bench POST body or the llama-server spawn args based on
   it.

Without this, Qwen3.x catalog entries bench with "thinking" enabled by
default, which 5-10x's eval time and is not what we're measuring.

### Gemma chat-template investigation
*Estimate: 0.5-1h research, then 1-2h implementation.*

`template_note` field marks Gemma 2 / 3 / 4 entries in the catalog.
Gemma uses specific BOS/EOS conventions that may distort timing if the
wrong template is applied. Need to:

1. Verify which template llama.cpp picks by default for each Gemma
   variant (`--chat-template gemma2`, `gemma3`, etc.).
2. If the default is wrong, either pin via `--chat-template <name>`
   or pre-format the prompt accordingly.

Same plumbing as `reasoning_mode` (thread through the bench item).

### Background-thread polling during the bench POST
*Estimate: 2-3h.*

Today's "live" polls run during the LOAD wait only. The bench POST is
synchronous; we take a single post-bench snapshot to grab the peak
GPU power/temp at the hottest moment. This works but isn't real-time.

To capture peaks DURING inference (not just on either side of it):

1. Spawn a PowerShell Runspace before the HTTP POST.
2. Runspace runs the existing `Get-GpuSnapshot` + CIM RAM/disk loop on
   a synchronized hashtable.
3. Main thread does the POST; after the response, reads the
   accumulated peaks from the shared hashtable.
4. Folds those into the per-run record.

Worth doing because the GPU is at its hottest during eval, not load.
Today's peak numbers are biased low.

### CustomBenchView v2
*Estimate: 2h.*

v1 (already shipped) lets the user multi-pick models from the catalog.
v2 adds the rest of what the user designed:

- **Typed search filter** at the top of the model list (live narrowing
  by model/series/variant/id substring).
- **Context-size checkbox set** (16k / 32k / 64k / 96k / 128k / 160k).
  Cross-product with selected models = the actual bench scope.
- **Save as user preset** — writes `data/user_bench_presets.json` so
  the selection can be re-used as a named preset later. The Phase B
  preset loader already merges user presets on top of defaults; this
  closes the loop.

### Per-sample elapsed timer
*Estimate: 30 min.*

The `all -FetchCatalog` per-sample loop already emits `[sample X/N]
sampleId` markers. Adding `[sample-done X/N] sampleId elapsed=MM:SS`
at the end of each iteration would let RunView show per-sample timing
in the live strip — useful when the loop is multi-hour and the user
wants to know "how long did Qwen3.5-9B take vs Gemma 4 E4B".

---

## Bigger / design-needed (the user explicitly deferred these earlier)

### KV-fill stub
*Estimate: 0.5-1d.*

Synthesize a long prompt to fill KV cache to 25/50/75/95% BEFORE timing
the request. Surfaces real attention-scaling cost at high ctx — today's
bench measures with an effectively-empty cache, so high-ctx numbers
look better than they would in actual chat use.

Design choices to settle:

- Filler content (random tokens? a known long doc?).
- How to express the per-fill-level measurements in the result JSON
  (sub-record per fill level, or separate result records).
- Default opt-in or opt-out per tier?

### Abstention bench
*Estimate: 1-2d.*

Integrate a quality test suite (the user has an abstention-bench they
used in another project — 1724 questions, no auth required). Opt-in,
multi-hour. Per-model honesty score that the report can render
alongside speed.

Open questions:

- Where does the prompt set live? (Bundle? Fetch?)
- Result schema (one row per model, or per (model, config)?).
- How to combine with the speed bench in the final report.

### Scoring profiles in report (configurable weights UI)
*Depends on: extended metrics (done), abstention bench (above).
Filter selector with four hard-coded profiles already shipped in Phase F.*

Replace the four hard-coded profile buttons with a UI that lets the
user dial weights themselves: speed / efficiency (perf/watt) / safety
(no-paging) / honesty / hardware-stress columns, each with a
0-100 slider; "save as user profile" persists to
`data/user_score_profiles.json` so the profile shows up alongside the
defaults.

Tied into the abstention bench for the honesty axis; without it, the
profile can dim that slider as N/A.

### GGUF metadata parser
*Estimate: 0.5d.*

A small PowerShell GGUF reader (no full parser, just the header KV
section) that extracts `<arch>.context_length` so user-owned `.gguf`
files (not in `models_catalog.json`) get a precise per-model context
cap. Today they fall through to the global `max_context_cap`.

---

## Roadmap (CLAUDE.md phases 2/3)

- **Phase 2 — NestJS backend** that exposes the engine operations the
  CLI invokes today. Enables clients other than the CLI and a shared
  online leaderboard.
- **Phase 3 — Angular UI** on top of the backend.
- **Cross-platform** clients (Linux / macOS / Android via Termux+TS,
  or thin agents that speak the Phase-2 API).
- **Trusted-publisher npm OIDC** so `NPM_TOKEN` is no longer needed in
  GitHub Actions.

---

## Pointers for whoever picks this up

- Current shippable state: `master` is tagged at v0.1.2 on npm.
  `feat/v1.1-quick-wins` is +N commits with everything above (renames,
  presets, custom view, +18 models, minimal-polling, label cleanup,
  report archival, init-in-all auto-fix).
- All engine helpers extracted as testable pure functions live in
  `calibr.ps1` (look for `Get-`, `Test-`, `Select-`, `New-`, `Find-`
  prefixes). 139 PowerShell tests in `tests/Helpers.Tests.ps1`.
- CLI views in `cli/src/*.tsx`, with one screen per concern. Engine
  boundary is `cli/src/engine.ts`. CLI smoke install is
  `cli/scripts/smoke-install.js`.
- `CLAUDE.md` documents the current methodology and what's REFERENCE
  ONLY (architecture/, spec/, plans/, memories/).
