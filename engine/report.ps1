# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: report
# ============================================================================
function Test-IsBetterWinner {
    # Decide whether $candidate should replace $current as the winner of its
    # group. Default rule: a non-paging config always beats a paging one;
    # among equally-safe configs, higher eval_tps wins. With -PreferSpeed:
    # safety is ignored, raw eval_tps is the only criterion.
    #
    # "Paging" means shared_peak_mib > $sharedConfirmMib. The default 500 MiB
    # matches wddm_detection.shared_delta_confirm_mib so the picker and the
    # report watchlist agree: small drift from background apps (Chrome, Discord)
    # at ~200-300 MiB is NOT counted as paging.
    #
    # Pure: no I/O, no globals, used by Invoke-Report and unit tests.
    param($candidate, $current, [switch]$preferSpeed, [int]$sharedConfirmMib = 500)
    if (-not $current) { return $true }
    if ($preferSpeed) { return ([double]$candidate.eval_tps -gt [double]$current.eval_tps) }
    $cSafe   = ([int]$candidate.shared_peak_mib -le $sharedConfirmMib)
    $curSafe = ([int]$current.shared_peak_mib   -le $sharedConfirmMib)
    if ($cSafe -and -not $curSafe) { return $true }
    if (-not $cSafe -and $curSafe) { return $false }
    return ([double]$candidate.eval_tps -gt [double]$current.eval_tps)
}

function Get-ResultDerivedFields {
    # Compute the derived metrics the report's charts need from a raw result.
    # Pure: no I/O, no globals. Tested in tests/unit/report.Tests.ps1.
    #   time_total_sec = prompt_n / prompt_tps + eval_n / eval_tps
    #   headroom_mib   = max(0, vram_total_mib - vram_peak_mib)
    #   ctx_size       = parsed from `--ctx-size N` in extra_args (else $null)
    param($result, [int]$vramTotal)

    $promptN  = if ($null -ne $result.prompt_n) { [int]$result.prompt_n } else { 0 }
    $evalN    = if ($null -ne $result.eval_n)   { [int]$result.eval_n }   else { 0 }
    $promptTs = if ($null -ne $result.prompt_tps) { [double]$result.prompt_tps } else { 0 }
    $evalTs   = if ($null -ne $result.eval_tps)   { [double]$result.eval_tps }   else { 0 }

    $timeTotal = $null
    if ($promptN -gt 0 -and $evalN -gt 0 -and $promptTs -gt 0 -and $evalTs -gt 0) {
        $timeTotal = [math]::Round(($promptN / $promptTs) + ($evalN / $evalTs), 2)
    }

    $vramPeak = if ($null -ne $result.vram_peak_mib) { [int]$result.vram_peak_mib } else { 0 }
    $headroom = [Math]::Max(0, $vramTotal - $vramPeak)

    $ctxSize = $null
    if ($result.extra_args -and ($result.extra_args -match '--ctx-size\s+(\d+)')) {
        $ctxSize = [int]$Matches[1]
    }

    return @{
        time_total_sec = $timeTotal
        headroom_mib   = $headroom
        ctx_size       = $ctxSize
    }
}

function Invoke-Report {
    $cfg = Get-Config
    Write-Host "=== report ===" -ForegroundColor Cyan

    $results = @()
    Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" | Sort-Object Name | ForEach-Object {
        $r = Get-Content $_.FullName -Raw | ConvertFrom-Json
        $results += $r
    }
    if ($results.Count -eq 0) { throw "No results. Run 'calibr bench' first." }

    # Dedupe stale result JSONs. A legacy concern: pre-v0.1.3 plan IDs
    # included an auto-incrementing index so the SAME logical config (same
    # model + variant + label) could end up in two files, e.g.
    # T001_Qwen3_5_0_8B_Q8_0_ctx_16384_kv_q8_0.json and
    # T007_Qwen3_5_0_8B_Q8_0_ctx_16384_kv_q8_0.json - the report then drew
    # two bars per config. New IDs are deterministic but old result files
    # still exist on disk, so we group by (model, variant, label) and keep
    # the newest timestamp per group. Counts before/after so the user
    # notices if their data/results/ has accumulated leftover junk worth
    # cleaning up.
    $rawCount = $results.Count
    $byKey = @{}
    foreach ($r in $results) {
        $key = "{0}|{1}|{2}" -f $r.model, $r.variant, $r.label
        if (-not $byKey.ContainsKey($key)) {
            $byKey[$key] = $r
        } else {
            $existingTs = if ($byKey[$key].timestamp) { $byKey[$key].timestamp } else { "" }
            $newTs      = if ($r.timestamp)            { $r.timestamp }            else { "" }
            if ($newTs -gt $existingTs) { $byKey[$key] = $r }
        }
    }
    $results = @($byKey.Values)
    if ($rawCount -gt $results.Count) {
        $orphaned = $rawCount - $results.Count
        Write-Host ("deduped {0} stale result file(s) (probably legacy T###-prefixed IDs); kept newest per (model, variant, config)" -f $orphaned) -ForegroundColor DarkYellow
    }

    # v1.0 migration: pre-v1 result JSONs used `family` and `quant`. Detect
    # any in the loaded set, backfill model/variant/series, and rewrite the
    # file so subsequent runs are clean. Idempotent.
    $migrated = 0
    foreach ($jsonFile in (Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" -ErrorAction SilentlyContinue)) {
        $r = Get-Content $jsonFile.FullName -Raw | ConvertFrom-Json
        $touched = $false
        if ($null -eq $r.model -and $r.PSObject.Properties.Name -contains 'family') {
            $r | Add-Member -NotePropertyName model -NotePropertyValue $r.family -Force
            $touched = $true
        }
        if ($null -eq $r.variant -and $r.PSObject.Properties.Name -contains 'quant') {
            $r | Add-Member -NotePropertyName variant -NotePropertyValue $r.quant -Force
            $touched = $true
        }
        if ($null -eq $r.series -and $r.model) {
            $s = $r.model
            if ($s -match '^(.+?)-[A-Z]?\d+(\.\d+)?B(-A\d+B)?(-it|-Instruct)?$') { $s = $Matches[1] }
            $r | Add-Member -NotePropertyName series -NotePropertyValue $s -Force
            $touched = $true
        }
        if ($touched) {
            $r.PSObject.Properties.Remove('family') | Out-Null
            $r.PSObject.Properties.Remove('quant')  | Out-Null
            $r | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile.FullName
            $migrated++
        }
    }
    if ($migrated -gt 0) {
        Write-Host ("migrated {0} result file(s) to v1 schema" -f $migrated) -ForegroundColor DarkGray
        # Reload the now-migrated results so the rest of the function sees the new shape.
        $results = @()
        Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" | Sort-Object Name | ForEach-Object {
            $results += (Get-Content $_.FullName -Raw | ConvertFrom-Json)
        }
    }

    # Pick winner per grouping key (model, or model+variant if -GroupBy model+variant).
    # Default safety rule: a config without WDDM paging always beats one that pages.
    # With -PreferSpeed: ignore safety, pick the highest eval_tps.
    function Get-GroupKey {
        param($r, $mode)
        if ($mode -eq "model+variant") { return "$($r.model)_$($r.variant)" }
        return $r.model
    }

    $confirmMib = if ($cfg.wddm_detection -and $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }
    $winners = @{}
    foreach ($r in ($results | Where-Object { $_.ok })) {
        $key = Get-GroupKey -r $r -mode $GroupBy
        if (Test-IsBetterWinner -candidate $r -current $winners[$key] -preferSpeed:$PreferSpeed -sharedConfirmMib $confirmMib) {
            $winners[$key] = $r
        }
    }

    Write-Host ("Grouping by '{0}'; produced {1} winner(s)" -f $GroupBy, $winners.Count)

    # Generate a launcher per winner: .bat (cmd) on Windows, executable .sh on
    # Linux/macOS. Both live under data/bats/.
    foreach ($key in $winners.Keys) {
        $w = $winners[$key]
        $base = ($key -replace '[^\w\.\-]', '_')
        # Split extra_args into pairs "--flag value" or bare switches "--flag".
        # Regex grabs a `--name` and optionally its following non-flag value.
        $pairs = [regex]::Matches($w.extra_args, '(--\S+)(?:\s+("[^"]*"|[^-\s]\S*))?') |
                 ForEach-Object { $_.Value.Trim() }
        if ($script:IsWin) {
            $launchName = "$base.bat"
            $launchPath = Join-Path $CALIBR_BATS_DIR $launchName
            $lines = @(
                "@echo off"
                "REM Auto-generated by calibr on $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
                "REM Model: $key"
                "REM Bench: prompt=$($w.prompt_tps) t/s, eval=$($w.eval_tps) t/s, VRAM peak=$($w.vram_peak_mib) MiB"
                "REM Test ID: $($w.id)"
                ""
                "`"$($cfg.llama_server_exe)`" ^"
                "    -m `"$($w.model_path)`" ^"
            )
            if ($w.mmproj_path) { $lines += "    --mmproj `"$($w.mmproj_path)`" ^" }
            foreach ($pair in $pairs) { $lines += "    $pair ^" }
            $lines += "    --metrics"
            $lines -join "`r`n" | Out-File -Encoding ascii $launchPath
        } else {
            $launchName = "$base.sh"
            $launchPath = Join-Path $CALIBR_BATS_DIR $launchName
            $lines = @(
                "#!/usr/bin/env bash"
                "# Auto-generated by calibr on $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
                "# Model: $key"
                "# Bench: prompt=$($w.prompt_tps) t/s, eval=$($w.eval_tps) t/s, VRAM peak=$($w.vram_peak_mib) MiB"
                "# Test ID: $($w.id)"
                ""
                "exec `"$($cfg.llama_server_exe)`" \"
                "    -m `"$($w.model_path)`" \"
            )
            if ($w.mmproj_path) { $lines += "    --mmproj `"$($w.mmproj_path)`" \" }
            foreach ($pair in $pairs) { $lines += "    $pair \" }
            $lines += "    --metrics"
            # LF endings, no BOM (the shebang must be the first bytes), then +x.
            [System.IO.File]::WriteAllText($launchPath, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
            try { & chmod +x $launchPath 2>$null } catch { }
        }
        Write-Host "  wrote $launchName"
    }

    # Build HTML (compact, self-contained)
    $cfgJson = $cfg | ConvertTo-Json -Depth 5 -Compress
    $vramTotal = if ($cfg.hardware -and $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $resJson = ($results | ForEach-Object {
        $r = $_
        $derived = Get-ResultDerivedFields -result $r -vramTotal $vramTotal
        $kvCache = if ($null -ne $r.kv_cache_mib) { [double]$r.kv_cache_mib } else { 0 }
        # Extended metrics may not exist on legacy result JSONs; fall back to
        # $null so the JS side renders '-' for missing values without crashing
        # the scorers (efficiency divides by gpu_power_peak_w; null is safe).
        $ttft   = if ($null -ne $r.ttft_sec)           { [double]$r.ttft_sec } else { $null }
        $gpuPw  = if ($null -ne $r.gpu_power_peak_w)   { [double]$r.gpu_power_peak_w } else { $null }
        $gpuTc  = if ($null -ne $r.gpu_temp_peak_c)    { [int]$r.gpu_temp_peak_c } else { $null }
        $gpuUt  = if ($null -ne $r.gpu_util_avg_pct)   { [int]$r.gpu_util_avg_pct } else { $null }
        $ramPk  = if ($null -ne $r.ram_used_peak_mib)  { [int]$r.ram_used_peak_mib } else { $null }
        $ramBl  = if ($null -ne $r.ram_baseline_mib)   { [int]$r.ram_baseline_mib } else { $null }
        # Failure-classification fields. The report needs them to give a
        # meaningful summary for failed configs (otherwise the row shows
        # zeros + 'unknown' fit and the user thinks the config wasn't run).
        $failReason   = if ($null -ne $r.failure_reason)           { [string]$r.failure_reason } else { $null }
        $unsupportedArch = if ($null -ne $r.unsupported_architecture) { [string]$r.unsupported_architecture } else { $null }
        $readyFlag    = if ($null -ne $r.ready) { [bool]$r.ready } else { $null }
        [ordered]@{
            id=$r.id; label=$r.label; model=$r.model; series=$r.series; variant=$r.variant; tier=$r.tier
            prompt_tps=([double]$r.prompt_tps); eval_tps=([double]$r.eval_tps)
            vram_peak_mib=([int]$r.vram_peak_mib); shared_peak_mib=([int]$r.shared_peak_mib)
            load_sec=([double]$r.load_sec); layers_offloaded=$r.layers_offloaded
            fit_status=$r.fit_status; wddm_vram_saturation=([double]$r.wddm_vram_saturation)
            wddm_flag_high_vram=$r.wddm_flag_high_vram; wddm_flag_shared_pos=$r.wddm_flag_shared_pos
            extra_args=$r.extra_args; ok=$r.ok
            # Paths exposed for client-side .bat generation in the report.
            # Filesystem-local, fine to surface in the HTML (the report itself
            # is meant to be opened on the same machine that ran the bench).
            model_path=$r.model_path
            mmproj_path=$r.mmproj_path
            # Failure-classification fields (matched against Get-FailureReason
            # in the engine). Null on successful runs.
            failure_reason=$failReason
            unsupported_architecture=$unsupportedArch
            ready=$readyFlag
            # Session + llama-server identity. Drives the report's
            # latest-session / by-llama-version filter widget. Missing on
            # pre-v0.1.6 result JSONs; the JS side falls back to "unknown".
            bench_session_id         = if ($null -ne $r.bench_session_id)         { [string]$r.bench_session_id }         else { 'unknown' }
            bench_session_started_at = if ($null -ne $r.bench_session_started_at) { [string]$r.bench_session_started_at } else { '' }
            llama_server_version     = if ($null -ne $r.llama_server_version)     { [string]$r.llama_server_version }     else { 'unknown' }
            llama_server_exe         = if ($null -ne $r.llama_server_exe)         { [string]$r.llama_server_exe }         else { '' }
            # Derived for the new charts and the headroom annotation:
            time_total_sec=$derived.time_total_sec
            headroom_mib=$derived.headroom_mib
            ctx_size=$derived.ctx_size
            kv_cache_mib=$kvCache
            # Extended metrics (added v1.2): used by the all-results table and
            # by the 'efficiency' scoring profile in the new report UI.
            ttft_sec=$ttft
            gpu_power_peak_w=$gpuPw
            gpu_temp_peak_c=$gpuTc
            gpu_util_avg_pct=$gpuUt
            ram_used_peak_mib=$ramPk
            ram_baseline_mib=$ramBl
        }
    }) | ConvertTo-Json -Depth 5 -Compress
    $winJson = ($winners.GetEnumerator() | ForEach-Object {
        [ordered]@{ model=$_.Key; winner_id=$_.Value.id; bat=(($_.Key -replace '[^\w\.\-]','_') + $(if ($script:IsWin) { '.bat' } else { '.sh' })) }
    }) | ConvertTo-Json -Depth 5 -Compress

    $now = (Get-Date).ToString("yyyy-MM-dd HH:mm")
    $templatePath = Join-Path $CALIBR_ROOT "report.template.html"
    if (-not (Test-Path $templatePath)) { throw "Missing report.template.html" }
    # -Encoding UTF8 is required: the template contains characters outside
    # ASCII (e.g. the ~ glyph in the headroom annotation). PS 5.1's default
    # is the system code page (Windows-1252 on Italian Windows), which would
    # silently mojibake those bytes on read and then re-encode the garbage
    # as 'valid' UTF-8 on write.
    $html = Get-Content $templatePath -Raw -Encoding UTF8
    $html = $html.Replace("%%NOW%%", $now).Replace("%%DATA%%", $resJson).Replace("%%WINNERS%%", $winJson).Replace("%%CFG%%", $cfgJson)

    # Preserve the previous report under data/reports/ before overwriting.
    # The 'current' report path stays stable so the CLI's `o` keybind and
    # the per-winner .bat launchers continue to point at one well-known
    # location, while history accumulates next door for after-the-fact
    # comparisons. Timestamp uses the OLD file's LastWriteTime (not now)
    # so the archive name reflects when that report was actually built.
    if (Test-Path -LiteralPath $CALIBR_REPORT) {
        try {
            $prevStamp = (Get-Item -LiteralPath $CALIBR_REPORT).LastWriteTime.ToString("yyyyMMdd-HHmmss")
            $archived  = Join-Path $CALIBR_REPORTS_DIR ("report-{0}.html" -f $prevStamp)
            # Collision guard: in the unlikely event two reports were
            # generated within the same second, suffix a numeric tag.
            $i = 1
            while (Test-Path -LiteralPath $archived) {
                $archived = Join-Path $CALIBR_REPORTS_DIR ("report-{0}-{1}.html" -f $prevStamp, $i)
                $i++
            }
            Move-Item -LiteralPath $CALIBR_REPORT -Destination $archived -Force -ErrorAction Stop
            Write-Host ("Archived previous report -> {0}" -f $archived) -ForegroundColor DarkGray
        } catch {
            Write-Host ("Could not archive previous report ({0}); overwriting in place." -f $_.Exception.Message) -ForegroundColor DarkYellow
        }
    }

    $html | Out-File -Encoding utf8 $CALIBR_REPORT
    Write-Host "Report: $CALIBR_REPORT" -ForegroundColor Green
}


