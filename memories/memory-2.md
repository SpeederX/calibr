# Memory snapshot 2 — post-v1.0.0

A primer for an LLM (or human) joining the project after the v1.0.0
release. Read this, then follow the pointers at the bottom for full
context.

> See `memories/memory-1.md` for the previous snapshot (pre-v0.3.2).
> Older snapshots are historical, not authoritative — always verify
> current state via `git log` and `git status` before acting.

## Snapshot meta

- **Date**: 2026-04-27
- **Project version on master**: v1.0.0
- **Project name**: `calibr` (was `llm-lab` through v0.3.2)
- **Active branch**: `feat/v1.0-rename` (about to merge to dev → master)
- **Remote**: none (local-only)

## What changed in v1.0.0

Two bundled refactors, both BREAKING:

1. **Taxonomy rename** — the field formerly called `family` is the
   *model* in the project's domain vocabulary (see
   `architecture/domain.md`). Renamed everywhere: code identifiers,
   JSON keys (catalog, plan, results, samples), CLI flag (`-Family`
   → `-Model`), `-GroupBy` values (`family|family+quant` →
   `model|model+variant`). Also `quant` → `variant`. New `series`
   field parsed from the model (`Qwen3.5-9B` → series `Qwen3.5`).

2. **Project rename** — `llm-lab` → `calibr`. Files renamed via
   `git mv` (blame preserved): `llm-lab.ps1` → `calibr.ps1`,
   `llm-lab.cmd` → `calibr.cmd`. All user-facing strings, install/
   uninstall banners, help dict examples, README, architecture docs,
   ROADMAP, samples.json, CI workflow, screenshot helper updated.

3. **Methodology doc** updated — `architecture/README.md` now states
   that while the project remains offline, breaking changes after
   v1.0.0 may ship as MINOR at maintainer discretion. Strict SemVer
   resumes when the project is published.

> Note (added 2026-05-13): the relaxed-versioning allowance applied
> to v1.0.0 only. From v1.0.1 onward, strict semantic versioning is
> in effect; see `memories/memory-3.md`.

Migration: pre-v1 `data/results/*.json` files (with `family`/`quant`
keys) get auto-migrated to the new schema on first `calibr report`
invocation. Idempotent.

## What's preserved as-is (do not touch)

- `plans/2026-04-25-*.md` and `plans/2026-04-26-*.md` — historical
  plans recording the work as it was done; rewriting them would erase
  the project's evolution.
- `memories/memory-1.md` — frozen pre-v0.3.2 snapshot.
- `spec/v1-taxonomy-rename.md` and `spec/v1-project-rename.md` —
  describe the v1.0.0 rename and necessarily reference the old
  `family` and `llm-lab` tokens.
- `spec/README.md` and `plans/README.md` indices — link to the above.

## What's open after v1.0.0

The next planned work is **v1.1.0 — report UX overhaul**:

- Memory-tier lines in scatter (VRAM, VRAM+WDDM, VRAM+RAM)
- Bar charts grouped by model with collapse-expand
- Column headers + ellipsis tooltips + `?` overlays explaining metrics
- All Results table sortable + searchable + group-by-model toggle
- Frontend test harness via Edge headless

Beyond that, `ROADMAP.md` lists wattage tracking, efficiency metrics,
custom-URL model lists, pre-flight fit estimation, log-scale-already-
done items, and the eventual cross-platform port.

## Pointers (in reading order)

1. **`README.md`** — user-facing intro and quickstart.
2. **`architecture/README.md`** — methodology, folder map, work cycle,
   semver convention (including the post-v1 offline relaxation).
3. **`architecture/domain.md`** — vocabulary. Authoritative now that
   the rename has landed.
4. **`architecture/design/`** — why each non-trivial choice was made.
5. **`architecture/ux/`** — what each user-facing flow looks like.
6. **`ROADMAP.md`** — what's open, what's done.
7. **`spec/`** and **`plans/`** — current and historical specs/plans.
8. **`calibr.ps1`** — the engine. Single file. Search by function
   name to locate logic.
9. **`tests/`** — `Helpers.Tests.ps1`, `Config.Tests.ps1`,
   `Report.Tests.ps1`. Run with `tests/run-tests.ps1`.

## Caveats for an LLM resuming work

- **Verify before acting**: snapshot is a moment in time. Check
  `git log --decorate --oneline -10` and `git status` first.
- **Vocabulary is now stable**: use `model` / `series` / `variant` /
  `tier`. Avoid reintroducing `family` / `quant` outside of the
  migration code in `Invoke-Report` and the historical artifacts
  listed above.
- **Project name is `calibr`** (lowercase). Don't reintroduce
  `llm-lab` in new files.
- **Tests are cheap**: ~30s for the full suite. Run before any
  non-trivial commit.
- **The maintainer runs Windows + Vulkan llama-server**: any test
  that depends on CUDA-only fields (`kv_cache_mib`) won't have data
  on this machine. Tests must handle the empty case.
- **No remote yet**: pushes are not authorized. Wait for explicit
  approval before adding/pushing to GitHub.
