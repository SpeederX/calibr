# Spec: rename project from `llm-lab` to `calibr`

## Goal

Re-brand from `llm-lab` (already taken on GitHub by an unrelated
project) to **`calibr`** — short for "calibrate", evoking the tool's
core job: calibrating a llama.cpp configuration to a specific machine.
The name is neutral with respect to LLMs / GGUF / llama.cpp specifically,
so it survives ecosystem shifts.

## Background

`llm-lab` is an existing GitHub repository
(`github.com/blazux/LLM-Lab`) for an unrelated tool. Distinct project
discoverability and branding are blocked.

`calibr` was chosen for: distinctiveness, brevity, ecosystem-neutral
semantics, and likely-available namespace.

## Behavior

### File renames

- `llm-lab.ps1` → `calibr.ps1`
- `llm-lab.cmd` → `calibr.cmd`
- `llm-lab/` directory: optional, user-driven. The PowerShell scripts
  resolve their own location via `$PSScriptRoot`, so the directory
  name does not matter. We do not rename the directory in the v1.0.0
  commit; once we go public on GitHub, `git clone https://github.com/<owner>/calibr.git`
  will create a `calibr/` directory by default.

### Internal global variables

- `$LAB_ROOT` → `$CALIBR_ROOT`
- `$LAB_DEFAULT_CFG` → `$CALIBR_DEFAULT_CFG`
- `$LAB_LOCAL_CFG` → `$CALIBR_LOCAL_CFG`
- `$LAB_DATA_DIR` → `$CALIBR_DATA_DIR`
- `$LAB_CATALOG`, `$LAB_PLAN`, `$LAB_RESULTS_DIR`, `$LAB_LOGS_DIR`,
  `$LAB_BATS_DIR`, `$LAB_REPORT` → all `$CALIBR_*` equivalents.

### Help system & user-facing strings

Every help entry, error message, install/uninstall banner, status
output, etc. that says `llm-lab` becomes `calibr`. The help system's
example invocations use `calibr <cmd>` form.

### Documentation

- `README.md`, `architecture/README.md`, `architecture/design/*.md`,
  `architecture/ux/*.md`, `architecture/domain.md`,
  `memories/memory-N.md`, `ROADMAP.md`, `plans/README.md`,
  `spec/README.md`, `tests/README.md` — all updated.
- Tagline kept: *"measure, don't guess: benchmark llama.cpp on
  consumer GPUs"*. The repository description on GitHub will use the
  same tagline.
- Historical plans (`plans/2026-04-25-bench-ux-hardening.md`,
  `plans/2026-04-25-chart-improvements.md`,
  `plans/2026-04-26-pipeline-polish.md`) are *not* edited — they
  documented the past and the past was named `llm-lab`. Touching them
  would rewrite history pointlessly.

### Tests

- `tests/Helpers.Tests.ps1`, `tests/Config.Tests.ps1`,
  `tests/Report.Tests.ps1` updated for any `llm-lab` literal in
  expected output (e.g. `Assert-True ($r.stdout -match "Usage: llm-lab config")`).

### CI

`.github/workflows/tests.yml` updated for the new script names.

## Acceptance

- [ ] `calibr.ps1 help` works and looks identical to v0.3.2's
      `llm-lab help` output, except every `llm-lab` token in the
      output is now `calibr`.
- [ ] `calibr.ps1 install` adds the project directory to User PATH
      (idempotent). `calibr.ps1 uninstall` removes it. Same logic, new
      messages.
- [ ] Existing users who had `llm-lab install` previously: the v1.0.0
      release notes tell them to uninstall the old shim and reinstall
      after the upgrade. (We accept this break.)
- [ ] `tests/run-tests.ps1` returns 76+/76+ pass.
- [ ] `grep -r 'llm-lab' .` after the rename returns matches only
      under `plans/2026-04-25-*.md`, `plans/2026-04-26-*.md` (historical),
      `memories/memory-1.md` (also historical), and possibly inside CI
      workflow or `.git/`. Code, config, current docs, and current
      tests are clean.

## Out of scope

- Renaming the local working directory `llm-lab/` → `calibr/`. The
  user can `mv` it themselves; PowerShell scripts use `$PSScriptRoot`.
- Setting up the GitHub remote (handled separately, in the "process"
  cluster of the roadmap).
- A migration aliasing `llm-lab.ps1` to `calibr.ps1`. Hard break per
  the v1.0.0 contract.
