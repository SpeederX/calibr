# Plan: pipeline polish (v0.3.0)

## Context

ROADMAP follow-up to v0.2.0. Three small, independent improvements that
collectively sharpen the existing pipeline without changing its shape:

- [spec/scatter-log-scale.md](../spec/scatter-log-scale.md)
- [spec/winner-picker-prefer-speed.md](../spec/winner-picker-prefer-speed.md)
- [spec/dense-overrides.md](../spec/dense-overrides.md)

Each is small enough to be its own commit; bundling for release-cadence
reasons (one tag instead of three for a 4-hour batch of work).

## Approach

### 1. Scatter log-10 X axis (template-only)

`renderScatter()` in `report.template.html`:

- Replace linear `xMax = max(time)*1.1` with log domain
  `[xMin, xMaxRaw*1.5]` where `xMin = max(0.05, min(time)*0.5)`.
- New `xs(v)` uses `Math.log10(max(v, xMin))` and the log span.
- Tick loop iterates log-space evenly (5 ticks). Render the linear
  value via `Math.pow(10, lv)` with `.toFixed(1)` when `< 10`, integer
  otherwise.

No PowerShell change. No data shape change. Unit test in `Report.Tests.ps1`:
template contains `Math.log10(`.

### 2. `dense_overrides` post-hoc filter

`config.default.json`:

```json
"dense_overrides": [],
```

`Invoke-Discover` (after `Get-ModelMetadata`):

```powershell
if ($meta.is_moe -and $cfg.dense_overrides -and ($cfg.dense_overrides -contains $meta.family)) {
    $meta.is_moe = $false
}
```

Tests:
- Unit on the new branch: with the family in the list, is_moe flips to false; otherwise unchanged.
- The `Get-ModelMetadata` helper itself unchanged (still records the regex match) — keep it pure, override at the call site.

### 3. `-PreferSpeed` flag

Extract the picker comparator into `Test-IsBetterWinner` for testability:

```powershell
function Test-IsBetterWinner {
    param($candidate, $current, [bool]$preferSpeed)
    if (-not $current) { return $true }
    if ($preferSpeed) { return ($candidate.eval_tps -gt $current.eval_tps) }
    $cSafe   = ($candidate.shared_peak_mib -le 0)
    $curSafe = ($current.shared_peak_mib -le 0)
    if ($cSafe -and -not $curSafe) { return $true }
    if ($cSafe -eq $curSafe -and $candidate.eval_tps -gt $current.eval_tps) { return $true }
    return $false
}
```

Add `[switch]$PreferSpeed` to the param block. Used by `report` and `all`.

`Invoke-Report` becomes:

```powershell
foreach ($r in ($results | Where-Object { $_.ok })) {
    $key = Get-GroupKey -r $r -mode $GroupBy
    if (Test-IsBetterWinner -candidate $r -current $winners[$key] -preferSpeed $PreferSpeed) {
        $winners[$key] = $r
    }
}
```

`Invoke-Help` adds `-PreferSpeed` to the `report` and `all` flag tables.

Tests in `Helpers.Tests.ps1`: 4 cases for `Test-IsBetterWinner`
(prefer-speed × paging) plus a "no current" base case.

## Files touched

| File                                      | Change |
|-------------------------------------------|--------|
| `report.template.html`                    | log-10 X axis in `renderScatter()` |
| `config.default.json`                     | + `dense_overrides: []` |
| `llm-lab.ps1`                             | + `[switch]$PreferSpeed` param; + `Test-IsBetterWinner` helper; `Invoke-Report` uses it; `Invoke-Discover` applies dense_overrides post-hoc; `Invoke-Help` mentions `-PreferSpeed` for `report` and `all`. |
| `tests/Helpers.Tests.ps1`                 | + `Test-IsBetterWinner` unit tests (5 cases) |
| `tests/Report.Tests.ps1`                  | + smoke check for log-10 X in template |
| `tests/Discover.Tests.ps1` (new, small)   | + dense_overrides override test (uses canned cfg + canned meta) |
| `ROADMAP.md`                              | mark items done |

## Verification

1. `tests/run-tests.ps1` — all green (existing 59 + ~6 new).
2. Manual: regenerate `data/report.html` against the existing 68-config
   dataset and visually confirm:
   - Scatter X ticks span multiple orders of magnitude (e.g. 0.5 / 1.4
     / 3.7 / 10 / 27).
   - A sub-second Qwen3.5-0.8B dot is visibly **inside** the chart, not
     on the Y axis.
3. Manual: `llm-lab report -PreferSpeed` and confirm at least one
   winner card flips to a paging config that has higher `eval_tps`.
4. Manual: add `dense_overrides: ["Qwen3.6-35B-A3B"]` to `config.json`,
   re-run `discover` + `plan`, confirm the family gets a Tier C
   `--gpu-layers` sweep instead of the Tier B `--n-cpu-moe` sweep.
   Then unset.

## Risk / trade-offs

- **Log-scale's degenerate case** (only one ok config, or all configs
  at identical time): `xMin` floor at 0.05 keeps the math defined; the
  single dot lands at the right edge. Cosmetic, not a crash.
- **`dense_overrides` exact match**: case-sensitive. If a user types
  `qwen3.6-35b-a3b` but the catalog says `Qwen3.6-35B-A3B`, the override
  won't fire. Acceptable for v0.3 (we can normalize in v0.4 if it bites).
- **`-PreferSpeed` is per-run**: not persisted to `config.json`. If a
  user wants it always on, they alias `llm-lab report -PreferSpeed`.
  Persisting it via config is a v0.4 conversation if it comes up.

## Branch + release

- Branch: `feat/pipeline-polish` off `dev`.
- Commits: (1) docs (this plan + 3 specs), (2) log-10 X + test,
  (3) dense_overrides + test, (4) `-PreferSpeed` + Test-IsBetterWinner +
  tests, (5) ROADMAP update.
- PR `feat/pipeline-polish` → `dev`. CI green.
- Release: `dev` → `master` with tag `v0.3.0` (MINOR — three new
  features, all backwards compatible: scatter still renders, default
  picker behavior unchanged, `dense_overrides` defaults to empty).
