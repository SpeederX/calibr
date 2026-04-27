# Plan: bench UX hardening (backend cross-check, progress bar, family-skip on arch failure)

## Context

During the first full run against `samples.json` (68 tests, ~20 min) the
user observed:

- **22 consecutive failures on the Gemma 4 models**, all with the same
  `peak=847 MiB` (idle GPU baseline). Cause: the WinGet-installed
  `llama-server.exe` build (`b8247`) does not support the `gemma4`
  architecture and exits with `unknown model architecture: 'gemma4'`
  before loading any weights. The script ran all 22 tests anyway,
  wasting ~10 min.
- **Backend is Vulkan, not CUDA**. The WinGet build ships with Vulkan +
  CPU. The script works but:
  - The regexes in `Invoke-OneBench` look for `CUDA0 model buffer size`
    / `CUDA0 KV buffer size`. On Vulkan those fields end up empty in
    the result JSON (the dashboard does not use them, so it is
    invisible — but it is latent technical confusion).
  - The CUDA build is ~10-15 % faster than Vulkan on NVIDIA. The user
    was not warned.
- **Poor progress output**. Just one `Write-Host` per test, no percent /
  ETA / final summary. The UX feels "rough".

The goal is to make `bench` more informative and more robust against
systemic per-family errors.

## Recommended approach

Three improvements, all confined to `llm-lab.ps1` (no HTML template, no
JSON schema change):

### 1. Cross-check GPU vs llama-server backend

**New function** `Get-LlamaBackends($exe)` — inspect the `ggml-*.dll`
siblings of the executable and return a hashtable
`@{ cuda; vulkan; metal; hip; sycl; cpu }`. Cheap (a single
`Get-ChildItem` in one directory), no side effects, no process probe.

**New function** `Test-BackendHealthy($cfg, $backends)` — return a list of
warning strings:

| Detected GPU (`hardware.gpu_name`) | Available backends | Warning |
|---|---|---|
| `NVIDIA …` | cuda=true | (none — optimal) |
| `NVIDIA …` | cuda=false, vulkan=true | "NVIDIA GPU but llama.cpp has no CUDA backend; Vulkan works but is ~10-15% slower. Get a CUDA build from https://github.com/ggml-org/llama.cpp/releases" |
| `AMD\|Radeon …` | hip=true OR vulkan=true | (none) |
| `AMD\|Radeon …` | neither | "AMD GPU but no HIP/Vulkan backend available" |
| other / empty | vulkan=true | (none) |
| other / empty | none | "No GPU backend (cuda/vulkan/hip) available; CPU only" |

**Invocation point**: top of `Invoke-Bench`, right after `Get-Config`,
before the loop. Printed in yellow. Non-blocking — the user can proceed
(the Vulkan build still works).

### 2. Progress bar + improved per-test line + final summary

**Replace the `Invoke-Bench` loop (current ~lines 696-702) with**:

```powershell
$total = $filtered.Count
$startTime = Get-Date
$i = 0
$abandoned = @{}   # see point 3
$summary = @()      # collected for the final table

foreach ($item in $filtered) {
    $i++

    if ($abandoned.ContainsKey($item.family)) {
        # see point 3: skip family
        ...
        continue
    }

    $elapsed = (Get-Date) - $startTime
    $etaSec  = if ($i -gt 1) { ($elapsed.TotalSeconds / ($i-1)) * ($total - $i + 1) } else { 0 }
    $etaStr  = if ($etaSec -gt 0) { "{0}m{1:D2}s" -f ([int]($etaSec/60)), ([int]($etaSec%60)) } else { "?" }

    Write-Progress -Activity "llm-lab bench" `
                   -Status   ("[$i/$total] running · ETA $etaStr") `
                   -CurrentOperation $item.label `
                   -PercentComplete (($i - 1) / $total * 100)

    Write-Host ("`n[$i/$total] $($item.label)") -ForegroundColor Cyan
    $r = Invoke-OneBench -item $item -cfg $cfg
    $summary += $r
    # detection of unsupported arch (see point 3)
    ...
}
Write-Progress -Activity "llm-lab bench" -Completed
```

**Why `Write-Progress` and not an in-place list**: 68 tests often exceed
the terminal height (e.g. 30-40 visible rows), and
`[Console]::SetCursorPosition` on rows scrolled out of the viewport
causes flickering and cursor displacement. `Write-Progress` is built-in,
always top-of-window, robust, and the scrolling `Write-Host` flow below
remains intuitive for scrolling back through history.

**Per-test summary line** (current line 672, inside `Invoke-OneBench`):
drop the test ID from the display (it stays in the JSON), emphasize
family/quant/label and number. Example:

```
[OK]   Qwen3.5-0.8B  Q8_0  ctx=16384 kv=q8_0       960 t/s prompt   140 t/s eval   peak 2232 MiB
[FAIL] gemma-4-E2B-it  Q4_K_M  ctx=16384 kv=q8_0  (unsupported architecture: gemma4)
[SKIP] gemma-4-E2B-it  Q4_K_M  ctx=32768 kv=q8_0  (family abandoned)
```

**Final summary at the end of `Invoke-Bench`**:

```
═══════════════════════════════════════════════════════════════
 llm-lab bench — done in 19m32s
   64 ok · 4 fail · 22 skipped (out of 90)
   abandoned families: gemma-4-E2B-it, gemma-4-E4B-it, gemma-4-26B-A4B-it, gemma-4-31B-it
   reason: unsupported architecture 'gemma4'
═══════════════════════════════════════════════════════════════
```

### 3. Detect "unknown model architecture" → skip the rest of the family

**In `Invoke-OneBench`**, after the stderr-parsing block (current
~lines 644-654), add:

```powershell
$mArch = [regex]::Match($err, "unknown model architecture: '([^']+)'")
if ($mArch.Success) { $result.unsupported_architecture = $mArch.Groups[1].Value }
```

**In `Invoke-Bench`**, after `$r = Invoke-OneBench …`:

```powershell
if (-not $r.ok -and $r.unsupported_architecture) {
    $abandoned[$item.family] = "unsupported architecture '$($r.unsupported_architecture)'"
    Write-Host "  -> abandoning remaining tests for family '$($item.family)' (update llama.cpp to fix)" -ForegroundColor DarkYellow
}
```

And at the top of the loop (shown above) the actual skip:

```powershell
if ($abandoned.ContainsKey($item.family)) {
    $reason = $abandoned[$item.family]
    Write-Host ("[SKIP] {0,-50} ({1})" -f $item.label, $reason) -ForegroundColor DarkYellow
    $summary += @{ id=$item.id; label=$item.label; family=$item.family; ok=$false; skipped=$true; skip_reason=$reason }
    continue
}
```

Skipped tests do **not** produce `data/results/*.json` files. They stay
out of the report (correctly: nothing to show). The console summary
counts them separately ("22 skipped"), so the user sees immediately that
the issue is systemic and not test-by-test.

## Files touched

| File | Changes |
|---|---|
| `llm-lab/llm-lab.ps1` | + `Get-LlamaBackends`, + `Test-BackendHealthy` (new functions, ~40 lines). Line ~672: change the summary-line format. Line ~683: add backend warnings at the top of `Invoke-Bench`. Lines ~696-702: rewrite the loop with `Write-Progress`, abandoned tracking, final summary table. Lines ~644-654: add the `unknown model architecture` regex. |

No other file: the HTML template does not read CUDA-specific fields
(`cuda_model_mib` & co.), so the fact that they are empty on Vulkan
remains a non-issue. README is optional: a note in "Requirements" that
the warning will appear if the build does not match the GPU.

## End-to-end verification

1. **Backend cross-check**: run `.\llm-lab.ps1 bench -DryRun` against the
   current WinGet (Vulkan) build and verify the yellow warning
   "NVIDIA GPU but llama.cpp has no CUDA backend …" is printed.
2. **Progress bar**: run `.\llm-lab.ps1 all` (even with a single model
   via `-Family Qwen3.5-0.8B`) and observe the top-of-window bar
   updating with `[i/total]` + ETA. Verify `Write-Progress -Completed`
   removes the bar at the end.
3. **Family skip**: with the current WinGet Vulkan build that does NOT
   support gemma4, run `.\llm-lab.ps1 bench -Family "gemma-4"` and
   verify that after the first `[FAIL]` with
   `unsupported architecture: gemma4`, the next 21 entries appear as
   `[SKIP] … (family abandoned)`. Expected total time: ~30 seconds
   instead of ~10 minutes.
4. **Final summary**: after (3), verify the closing table reports
   `1 fail · 21 skipped (out of 22)` and lists the abandoned families.
5. **No regression**: verify that existing `data/results/*.json` files
   are reused as cache (without `-Force`) and that the HTML report
   still reads its fields correctly (`vram_peak_mib`, `eval_tps`,
   `wddm_*`, `layers_offloaded`, …).
6. **Parser sanity**:
   `[System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$errs)`
   must return zero errors.
