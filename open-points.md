# calibr — open points

Operational TODO captured at the end of the v0.1.x feature-push session.
Nothing here is blocking; the CLI on `feat/v1.1-quick-wins` is shippable
as-is. This file is the queue for what we picked up next.

Items are grouped by *kind of work*, not strict priority. Within each
group the rough order is "smaller / more isolated first".

---

## Engine + CLI: deferred but designed

### Phase F — report UI redesign
*Estimate: 2-3h.*

Mockup from the user lives in `report_ui/Screenshot 2026-06-01 125229.png`
(gitignored). Notes from the conversation:

- **Memory vs latency chart moves to the FIRST visible section**, above
  the winners grid. It is the most diagnostic single view of a bench
  run.
- **Per-config rows collapse under expandable model rows**. The
  collapsed header row shows the WINNING config for the currently
  selected filter; expand to see all configs for that model.
- **Eval tokens / VRAM peak become tabs of the same widget** instead
  of two separate sections.
- **Top-level filter selector** that changes the winner criterion
  (speed / efficiency / safety-balanced / overall-weighted). This is
  effectively the embryo of *scoring profiles* — when item 10 lands,
  the filter selector grows to expose configurable weighted matrices.
- The "deduped N stale result file(s)" engine line means the report
  ALREADY collapses legacy T###-prefix duplicates; that work doesn't
  need to be redone in the UI.

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
   ROCm if AMD, CPU-only as fallback. (CUDA version needs to match the
   driver — `nvidia-smi --query-gpu=driver_version` gates this.)
3. Resolve the latest build tag from the GitHub releases API (or
   accept a config-pinned `bN`).
4. Download into `~/AppData/Local/calibr/llama-bin/<bN>/`. Unzip there.
   For CUDA, also fetch + unzip cudart into the same dir.
5. Point `llama_server_exe` at the new path; persist in `config.json`.

UX-wise, this means `init` no longer fails when llama isn't installed —
it offers to fetch it. Add a confirmation prompt in interactive mode
(`Download ~250 MB from GitHub? y/N`), bypassable with `-AutoFetchLlama`
flag for headless setups.

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

### Scoring profiles in report
*Depends on: extended metrics (done), abstention bench (above).*

Weighted matrix in the report: each row is a config; columns are
speed / efficiency (perf/watt) / honesty / hardware-stress; the user
picks a profile to re-sort the leaderboard. The filter selector
landing in Phase F is the embryo of this.

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
