# Tests

Custom Describe/It harness (`harness.ps1`), zero external dependencies. Works
on every Windows PS 5.1+ install and on PS Core / pwsh, so CI doesn't have to
provision Pester.

## Run all tests

From the project root:

```powershell
.\tests\run-tests.ps1
```

Or filter by file substring:

```powershell
.\tests\run-tests.ps1 -Filter unit\bench
.\tests\run-tests.ps1 -Filter config
```

## Layout

| Path | What it covers |
|------|----------------|
| `harness.ps1` | Tiny `Describe / It / Assert-*` harness. Dot-sourced by every `*.Tests.ps1`. |
| `unit/*.Tests.ps1` | Unit tests mirrored to engine modules: config, discover, catalog, plan, bench, report, commands. |
| `integration/*.Tests.ps1` | Command-level tests that spawn `calibr.ps1` as a real subprocess. |
| `static/*.Tests.ps1` | Static consistency checks for bundled catalogs / preset data. |
| `smoke/*.mjs` | Node helpers and demos used by report/CLI smoke paths. |
| `run-tests.ps1` | Recursive discovery + runner. Each `*.Tests.ps1` runs in its own subprocess to keep global state isolated. |

## Adding a test

1. Create `<Topic>.Tests.ps1` under the matching responsibility folder.
2. Top of file:
   ```powershell
   . "$PSScriptRoot\..\harness.ps1"
   . "$PSScriptRoot\..\..\calibr.ps1"   # only for unit tests; the dot-source
                                          # guard skips the dispatch
   ```
3. Use `Describe` / `It` blocks with `Assert-Equal`, `Assert-True`,
   `Assert-False`, `Assert-Throws`.
4. End the file with `Exit-WithResults` so the runner picks up the exit code.

## Why not Pester?

Pester is a fine framework, but Pester 5+ requires `Install-Module` (network,
admin or `-Scope CurrentUser`). Pester 3.x ships with Windows but uses an
older syntax. To avoid the version dance and the install step in CI, we
ship our own ~70-line harness. If the test surface grows, swap it for Pester
with a small mechanical migration (`Should -Be` instead of `Assert-Equal`).
