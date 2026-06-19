# Override-only local config

> **Current engine reference.** Guided preferences are the primary user
> surface; the raw PowerShell adapter still uses this merge model.

## Why

Two competing needs:

1. Ship sensible defaults so a fresh clone Just Works without first running
   a setup wizard.
2. Let users override anything (paths, hardware, sweep ranges) without their
   personal absolute paths leaking into the repo.

## Approach

Two files:

- `config.default.json` — committed, contains the full schema and every
  default value. The single source of truth for what keys exist.
- `config.json` — gitignored, written by `init`, `config set`, `config detect`.
  Contains **only the keys the user has overridden**, never the defaults.

`Get-Config` deep-merges them at runtime: default ← local. CLI flags
(`-ScanPath`, `-LlamaServer`) override the merged config but are never
persisted to disk.

`Get-NestedValue`, `Set-NestedValue`, and `Remove-NestedValue` operate on
dot-paths (`hardware.vram_total_mib`). `Remove-NestedValue` also prunes
empty parent hashtables walking back up the chain, so set+unset pairs
don't leave carcasses like `wddm_detection: {}` in the file.

## Pros

- A user's `config.json` is small and meaningful: the overrides are the
  decisions worth reviewing.
- Adding a default in `config.default.json` automatically applies to every
  existing user without a migration step.
- `git diff config.default.json` shows actual schema evolution; nobody's
  paths pollute it.
- `config unset <key>` deletes the local override and falls back to the
  default — no special "clear" flag needed.

## Cons

- Two files to read mentally. The `config list` action shows both with
  `[default]` / `[local]` markers to mitigate.
- `config set` rejects keys not in the schema (so a typo doesn't silently
  bury a value). Adding a brand-new key requires editing
  `config.default.json` directly. This is a feature, not a bug.

## Takeaway

Pattern lifted from VS Code's `settings.json` / `defaultSettings.json`. It
is robust precisely because the implementation is dumb: shallow read of
both, deep merge, write only the user-touched keys. The complexity stays
in the application code (typed coercion, parent-pruning on remove), not
in the file format.
