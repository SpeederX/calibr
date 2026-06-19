# calibr — repository operating guide

This is the source of truth for work in this repository. Historical material
under `architecture/design`, `architecture/ux`, `spec`, `plans`, `memories`,
and `ROADMAP.md` is useful context but does not override this file.

## Product state

calibr is an installable Node.js + Ink CLI. The primary user journey is
`guided run`: choose llama.cpp, choose local or catalog models, select scope
and policies, run the benchmark, and inspect the results/report.

The migration from the original PowerShell application is well advanced:

- TypeScript owns the interactive CLI, guided-run policy, llama-server
  lifecycle on the CUDA path, repeated-run coordination, HTTP benchmark
  sequence, streaming telemetry, metric derivation, result aggregation, and
  CLI result views.
- PowerShell remains the portable engine adapter and fallback. It owns
  configuration/platform probes, model discovery, sweep expansion, catalog
  download/rotation, report file emission, non-CUDA fallback paths, and the raw
  maintenance interface.
- `engine/workflow.ps1` is the unified raw workflow invoked by guided run.
  `discover.ps1`, `plan.ps1`, `bench.ps1`, and `report.ps1` are internal stage
  modules with separate artifacts; they are not the primary UX.

Do not describe the product as a set of four commands. The raw commands exist
for maintainers, diagnostics, CI, and resumable/headless work.

## Operating principles

- Keep process minimal. No spec/plan ceremony unless it helps the task.
- Prefer the smallest complete implementation and verify it proportionally.
- Update `README.md` for user-visible behavior, `METRICS.md` for metric
  semantics, and `HOW-IT-WORKS.md` for architecture/runtime changes.
- Preserve user changes in a dirty worktree. Do not reset or overwrite them.
- Add cheap tests for real regressions.
- Breaking changes are acceptable during this phase; explain them in commits.
- Do not create migration shims for hypothetical users.

## Architecture direction

Current phase: ship and harden the TypeScript CLI.

Later phases are conditional, not scheduled:

1. a local HTTP/backend boundary when multiple clients justify it;
2. a web UI only after that API exists and has a demonstrated need.

Do not scaffold NestJS or Angular ahead of those decisions. Continue moving
PowerShell responsibilities only when there is a concrete product,
cross-platform, testability, or performance reason.

## Vocabulary

`architecture/domain.md` is authoritative. Use `lineage`, `series`, `model`,
`variant`, `run config`, `sweep`, `level`, `winner`, `backend`, `WDDM`,
`saturation`, and `headroom`. Do not reintroduce `family`, `quant`, or the old
A/B/C tier terminology.

## Branch flow

- Normal work starts from `dev`.
- Feature branches merge into `dev`.
- `dev` is promoted to `master` for release.
- Hotfixes on `master` must be merged back into `dev`.

## Check in with the maintainer for

- new top-level dependencies;
- schema/public-interface breaks with lasting consequences;
- language/framework changes or a new engine adapter;
- a phase transition;
- work likely to exceed half a day.

Routine implementation and consistency decisions do not need a check-in.
