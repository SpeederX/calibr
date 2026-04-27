# Memory snapshot 1 — pre-v0.3.2

A primer for an LLM (or human) joining the project. Read this, then follow
the pointers at the bottom for full context.

> **How to use this folder**: each `memory-N.md` is a frozen state-of-the-
> project snapshot, written before a context compaction or hand-off. The
> later the number, the more recent the snapshot. Treat older snapshots
> as historical, not authoritative — verify against tags, branches, and
> latest commits before acting.

## Snapshot meta

- **Date**: 2026-04-27
- **Project version on master**: v0.3.1
- **Active branch**: `chore/v0.3.2-scaffolding-and-i18n`
- **Remote**: none (local-only; planned for a later release)
- **Provisional new project name**: `calibr` (rename pending)

## What this project is

A benchmark crawler/tester for local GGUF models served by
[llama.cpp](https://github.com/ggml-org/llama.cpp) on Windows. It catalogs
models on disk, plans a tier-aware sweep of `llama-server` configurations
per model, runs each, detects silent WDDM paging on Windows, and emits an
HTML dashboard plus per-model `.bat` launchers.

Single PowerShell script (~1700 lines), single self-contained HTML
template, custom Describe/It test harness with zero external dependencies.

## Stack

- **PowerShell 5.1+** (also runs on PS Core / pwsh)
- **Windows-first**: the WDDM-paging detection uses a Windows-specific
  perf counter; on Linux/macOS the silent-paging failure mode this tool
  primarily targets does not exist, but a port is on the roadmap
- **Vanilla HTML + JS** for the report (no framework, no build step)
- **Custom test harness** (`tests/harness.ps1`, ~70 lines) — chosen over
  Pester to avoid an `Install-Module` step in CI

## Methodology

Documented in `architecture/README.md`. Highlights:

- **Gitflow lite**: long-lived `master` (tagged releases) and `dev`
  (integration); short-lived `feat/`, `chore/`, `hotfix/` branches.
- **SemVer-with-convention**: while the project is in `0.x.y`, breaking
  changes are allowed at MINOR bumps (per SemVer 2.0). Once we hit
  v1.0.0 the API is considered stable and breaks become MAJOR.
- **Spec → plan → code** flow: a small spec in `spec/` declares *what*,
  a bigger plan in `plans/` declares *how*, then the work happens.
- **Decision rationale** in `architecture/design/` (one file per
  non-trivial choice; `Why / Pros / Cons / Empirical takeaway` body).
- **UX flows** in `architecture/ux/` (one file per use case, written from
  the user's perspective).
- **English-only** in code, comments, docs. Italian is fine in chat / PR
  discussion, never in committed text.

## Recent timeline

| Tag | What landed |
|---|---|
| v0.1.0 | Pipeline (discover/plan/bench/report), WDDM detection, samples.json reference set, config CLI, install/uninstall, help system, tests, CI scaffold. |
| v0.2.0 | Memory-vs-latency scatter chart, VRAM bar chart sorted ascending, headroom annotation per row. |
| v0.3.0 | Log-10 X axis on scatter; `dense_overrides` to bypass MoE filename false positives; `-PreferSpeed` flag opts out of safety preference. |
| v0.3.1 | Hotfix: winner picker safety threshold now uses `shared_delta_confirm_mib` instead of `> 0`. |
| v0.3.2 (this commit) | `architecture/domain.md`, `memories/` pattern, root README pointer, English-only sweep across docs. |

## Where the work is heading next

Likely sequence (not committed):

1. **v0.4.0** — taxonomy rename: `family` → `model`, add `series`. Migrates
   `data/results/*.json`, `samples.json`, CLI flag `-Family` → `-Model`.
2. **v0.5.0** — project rename to `calibr`.
3. **v0.6.0** — report UX overhaul: memory tiers in scatter
   (VRAM/WDDM/RAM lines), group-by-model with collapse-expand, header
   tooltips, sortable + searchable All Results, frontend test harness.
4. **v0.7.0+** — wattage tracking via `nvidia-smi --query-gpu=power.draw`,
   efficiency metric, "best-in-class" cards.
5. **v1.0.0** — API frozen, public-facing release. Cross-platform port
   may anchor here.

See `ROADMAP.md` for the authoritative open list.

## Pointers (in reading order)

1. **`README.md`** — user-facing intro and quickstart.
2. **`architecture/README.md`** — methodology, folder map, work cycle.
3. **`architecture/domain.md`** — vocabulary; **read this** before diving
   into specs/plans, since terminology is shifting (`family` → `model`).
4. **`architecture/design/`** — why each non-trivial choice was made.
5. **`architecture/ux/`** — what each user-facing flow looks like.
6. **`ROADMAP.md`** — what's open, what's done, in what bump.
7. **`spec/`** and **`plans/`** — current and historical specs/plans.
8. **`llm-lab.ps1`** — the engine. Single file. Search by function name
   to locate logic.
9. **`tests/`** — `Helpers.Tests.ps1`, `Config.Tests.ps1`,
   `Report.Tests.ps1`. Run with `tests/run-tests.ps1`.

## Caveats for an LLM resuming work

- **Verify before acting**: this snapshot is a moment in time. Branches,
  tags, and commits may have moved on. Always run `git log --decorate
  --oneline -5` and `git status` first.
- **Don't rename files past `architecture/domain.md` defines**: the
  taxonomy rename is in flight. Adding new code that uses `family`
  prolongs the debt.
- **Tests are cheap**: `tests/run-tests.ps1` finishes in ~30s. Run before
  any non-trivial commit.
- **The user runs Windows + Vulkan llama-server**: any test that depends
  on CUDA-only fields (`kv_cache_mib`) will not have data on this
  machine. Tests must handle the empty case.
- **No remote yet**: pushes are not authorized. Wait for explicit
  approval before adding/pushing to GitHub.
