# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# WDDM SHARED-GPU MEMORY POLLER (Windows only)
# ============================================================================
function Get-SharedGPUMemoryMib {
    # The amount of GPU memory that has spilled into system RAM when the
    # dedicated VRAM pool saturates - the exact failure calibr exists to catch.
    # Windows exposes it as the WDDM "Shared Usage" perf counter; on Linux/AMD
    # the equivalent is GTT (memory the GPU maps from system RAM), read from the
    # radeontop stream. Either way the downstream machinery is identical:
    # baseline-subtracted peak delta vs shared_delta_confirm_mib. Returns MiB,
    # or -1 when no source is available (caller treats -1 as "skip").
    if ($script:IsWin) {
        try {
            $c = Get-Counter "\GPU Adapter Memory(*)\Shared Usage" -ErrorAction SilentlyContinue -MaxSamples 1
            if ($c) {
                $total = ($c.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum
                return [int]($total / 1MB)
            }
        } catch { }
        return -1
    }
    # Linux/AMD: GTT used (MiB) from the radeontop stream (Start-LinuxGpuMonitor).
    if ($script:_rtFile -and (Test-Path $script:_rtFile)) {
        try {
            $line = Get-Content -LiteralPath $script:_rtFile -Tail 4 -ErrorAction SilentlyContinue |
                    Select-String -Pattern '\bgtt\b' | Select-Object -Last 1
            if ($line -and $line.Line -match 'gtt\s+[\d.]+%\s+([\d.]+)mb') {
                return [int][double]$Matches[1]
            }
        } catch { }
    }
    return -1  # unavailable
}

# ============================================================================
# SUBCOMMAND: bench
# ============================================================================
function Get-Median {
    # Median of a numeric collection. Pure: no I/O, no globals. Tested in
    # tests/unit/bench.Tests.ps1.
    #
    # - Odd N: middle element after sort.
    # - Even N: lower of the two middle elements (no averaging). The metrics
    #   this is used on (vram_peak_mib, shared_peak_mib) are integer-valued;
    #   an averaged median would introduce non-integer values that mislead
    #   a reader scanning the report.
    # - N = 1: the single element.
    # - Empty / all-null input: $null.
    # - Nulls are filtered before sorting so callers don't have to pre-filter.
    param($values)
    if ($null -eq $values) { return $null }
    $nums = @($values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ })
    if ($nums.Count -eq 0) { return $null }
    $sorted = $nums | Sort-Object
    return $sorted[[int]([math]::Floor(($sorted.Count - 1) / 2))]
}

function New-AggregatedBenchResult {
    # Combine N per-run hashtables (from Invoke-OneBenchRun) plus the
    # planning $item metadata into a single top-level successful result.
    # Varying metrics carry the median over runs; deterministic metrics
    # carry the value from runs[0]. WDDM-derived flags are recomputed
    # from the medians so the top-level reflects median behavior, not
    # run-by-run noise. Pure: no I/O, no globals. Tested in
    # tests/unit/bench.Tests.ps1. See spec/n-run-median.md.
    param($item, $cfg, $runs)

    $first = $runs[0]
    $vramTotal = if ($null -ne $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $confirmThresh = if ($null -ne $cfg.wddm_detection.shared_delta_confirm_mib) { [int]$cfg.wddm_detection.shared_delta_confirm_mib } else { 500 }
    $satThresh = if ($null -ne $cfg.wddm_detection.vram_saturation_threshold) { [double]$cfg.wddm_detection.vram_saturation_threshold } else { 0.92 }

    $vramPeakMed   = [int](Get-Median -values @($runs | ForEach-Object { $_.vram_peak_mib }))
    $sharedPeakMed = [int](Get-Median -values @($runs | ForEach-Object { $_.shared_peak_mib }))
    $promptTpsMed  = [math]::Round((Get-Median -values @($runs | ForEach-Object { $_.prompt_tps })), 2)
    $evalTpsMed    = [math]::Round((Get-Median -values @($runs | ForEach-Object { $_.eval_tps })),   2)

    # Extended-metric medians/aggregates. ttft and util are median over runs;
    # power, temp, ram are max-over-runs (peaks are what matter for thermal
    # / pressure analysis, not the typical reading).
    $ttftMed       = [math]::Round((Get-Median -values @($runs | ForEach-Object { $_.ttft_sec })),         3)
    $utilAvgMed    = [int](Get-Median   -values @($runs | ForEach-Object { $_.gpu_util_avg_pct }))
    $powerPeakMax  = [math]::Round((@($runs | ForEach-Object { $_.gpu_power_peak_w }) | Measure-Object -Maximum).Maximum, 1)
    $tempPeakMax   = [int]((@($runs | ForEach-Object { $_.gpu_temp_peak_c })  | Measure-Object -Maximum).Maximum)
    $ramPeakMax    = [int]((@($runs | ForEach-Object { $_.ram_used_peak_mib }) | Measure-Object -Maximum).Maximum)
    $diskPeakMax   = [math]::Round((@($runs | ForEach-Object { $_.disk_read_peak_mb_s }) | Measure-Object -Maximum).Maximum, 1)

    $satRatio = if ($vramTotal -gt 0) { [math]::Round($vramPeakMed / $vramTotal, 3) } else { 0 }
    $flagHighVram  = ($satRatio -gt $satThresh)
    $flagSharedPos = ($sharedPeakMed -gt $confirmThresh)

    $result = [ordered]@{
        id              = $item.id
        label           = $item.label
        model           = $item.model
        variant         = $item.variant
        series          = $item.series
        level           = $item.level
        sweep           = $item.sweep
        reasoning_mode  = $item.reasoning_mode
        template_note   = $item.template_note
        gguf_context_length = $item.gguf_context_length
        gguf_architecture = $item.gguf_architecture
        timestamp       = $first.timestamp
        model_path      = $item.model_path
        mmproj_path     = $item.mmproj_path
        extra_args      = $item.extra_args

        # Deterministic / first-run fields
        vram_before_mib  = $first.vram_before_mib
        load_sec         = $first.load_sec
        ready            = $first.ready
        prompt_n         = $first.prompt_n
        eval_n           = $first.eval_n
        cpu_model_mib    = $first.cpu_model_mib
        cuda_model_mib   = $first.cuda_model_mib
        kv_cache_mib     = $first.kv_cache_mib
        compute_cuda_mib = $first.compute_cuda_mib
        compute_host_mib = $first.compute_host_mib
        layers_offloaded = $first.layers_offloaded
        fit_status       = $first.fit_status

        # Median over runs for varying metrics
        vram_peak_mib    = $vramPeakMed
        shared_peak_mib  = $sharedPeakMed
        prompt_tps       = $promptTpsMed
        eval_tps         = $evalTpsMed

        # Extended metrics: medians for ttft/util (typical), maxes for
        # power/temp/ram/disk (peaks are what matter).
        ttft_sec             = $ttftMed
        gpu_util_avg_pct     = $utilAvgMed
        gpu_power_peak_w     = $powerPeakMax
        gpu_temp_peak_c      = $tempPeakMax
        ram_baseline_mib     = $first.ram_baseline_mib
        ram_used_peak_mib    = $ramPeakMax
        disk_read_peak_mb_s  = $diskPeakMax

        # WDDM-derived recomputed from the medians (not the raw runs)
        wddm_vram_saturation = $satRatio
        wddm_flag_high_vram  = $flagHighVram
        wddm_flag_shared_pos = $flagSharedPos

        ok    = $true
        error = $null

        # Session + llama-server identity (added v0.1.6). Stamped on every
        # result so the report can filter by "latest session" / "latest per
        # llama version" and the cache can re-run failures recorded against
        # an older llama-server build. Defaults to "unknown" if a caller
        # invoked the aggregator without Initialize-BenchSession (test
        # fixtures, etc.).
        bench_session_id         = if ($script:BENCH_SESSION_ID)         { $script:BENCH_SESSION_ID }         else { 'unknown' }
        bench_session_started_at = if ($script:BENCH_SESSION_STARTED_AT) { $script:BENCH_SESSION_STARTED_AT } else { '' }
        llama_server_version     = if ($script:LLAMA_SERVER_VERSION)     { $script:LLAMA_SERVER_VERSION }     else { 'unknown' }
        llama_server_exe         = if ($cfg.llama_server_exe)            { $cfg.llama_server_exe }            else { '' }

        # Raw per-run records for audit (full schema-of-record for variance work)
        runs  = @($runs)
    }
    return $result
}

function Get-GpuSnapshot {
    # Single nvidia-smi call that returns memory.used + power.draw +
    # temperature.gpu + utilization.gpu in one CSV row, so the polling loop
    # pays one process spawn per tick instead of four. Returns a hashtable
    # with sensible fallbacks if any field comes back as 'N/A' (some Quadro
    # / Tesla SKUs don't report power.draw, for instance).
    $line = ""
    try {
        $line = (nvidia-smi --query-gpu=memory.used,power.draw,temperature.gpu,utilization.gpu --format=csv,noheader,nounits) -replace '\s',''
    } catch { }
    # No nvidia-smi (e.g. AMD/Linux): fall back to sysfs (temperature only).
    if (-not $line -and -not $script:IsWin) { return Get-GpuSnapshotLinux }
    $parts = if ($line) { $line -split ',' } else { @('0','0','0','0') }
    return @{
        mem_mib  = if ($parts[0] -match '^\d') { [int]$parts[0] }      else { 0 }
        power_w  = if ($parts[1] -match '^\d') { [double]$parts[1] }    else { 0 }
        temp_c   = if ($parts[2] -match '^\d') { [int]$parts[2] }      else { 0 }
        util_pct = if ($parts[3] -match '^\d') { [int]$parts[3] }      else { 0 }
    }
}

function Get-AvailableMemoryMib {
    # System-wide free RAM in MiB. We use CIM/WMI rather than Get-Counter
    # because perf-counter NAMES are localized on non-English Windows
    # (Italian: '\Memoria\MByte disponibili' vs the English '\Memory\Available
    # MBytes'), and Get-Counter rejects the English name on a localized
    # system. Win32_OperatingSystem.FreePhysicalMemory is in kilobytes and
    # language-independent.
    if ($script:IsMac) {
        return Get-MacAvailableMemoryMib
    }
    if (-not $script:IsWin) {
        try {
            $m = Select-String -Path /proc/meminfo -Pattern '^MemAvailable:\s+(\d+)\s*kB' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { return [int]([int64]$m.Matches[0].Groups[1].Value / 1024) }   # KB -> MiB
        } catch { }
        return -1
    }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        return [int]($os.FreePhysicalMemory / 1024)   # KB -> MiB
    } catch { return -1 }
}

# Disk-read state cached between polls because the raw-byte counter is
# monotonic; we compute a rate from two consecutive samples.
$script:_lastDiskReadBytes  = [int64]0
$script:_lastDiskReadAt     = [datetime]::MinValue

function Get-DiskReadBytesPerSec {
    # Total physical-disk read throughput. Same localization story as RAM:
    # the perf-counter path '\PhysicalDisk(_Total)\Disk Read Bytes/sec' is
    # translated on Italian Windows. We use the CIM PerfFormattedData class
    # first (DiskReadBytesPersec is an English property name regardless of
    # OS locale); if that fails we compute a rate from two raw-byte samples.
    if (-not $script:IsWin) {
        # /sys/block lists whole devices only (no partitions, so no
        # double-counting). stat field index 2 (0-based) is sectors read;
        # one sector = 512 bytes. Rate computed from two samples like Windows.
        try {
            $totalSectors = [int64]0
            foreach ($blk in (Get-ChildItem /sys/block -ErrorAction SilentlyContinue)) {
                if ($blk.Name -match '^(loop|ram|zram|dm-|sr|fd)') { continue }
                $statPath = Join-Path $blk.FullName 'stat'
                if (-not (Test-Path $statPath)) { continue }
                $stat = @(((Get-Content $statPath -ErrorAction SilentlyContinue) -split '\s+') | Where-Object { $_ -ne '' })
                if ($stat.Count -ge 3) { $totalSectors += [int64]$stat[2] }
            }
            $nowBytes = $totalSectors * 512
            $nowAt    = Get-Date
            $rate = 0
            if ($script:_lastDiskReadAt -ne [datetime]::MinValue) {
                $dt = ($nowAt - $script:_lastDiskReadAt).TotalSeconds
                if ($dt -gt 0) {
                    $rate = [int64](($nowBytes - $script:_lastDiskReadBytes) / $dt)
                    if ($rate -lt 0) { $rate = 0 }
                }
            }
            $script:_lastDiskReadBytes = $nowBytes
            $script:_lastDiskReadAt    = $nowAt
            return $rate
        } catch { return 0 }
    }
    try {
        $perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
        if ($perf -and $null -ne $perf.DiskReadBytesPersec) {
            return [int64]$perf.DiskReadBytesPersec
        }
    } catch { }
    try {
        $raw = Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
        if (-not $raw) { return 0 }
        $nowBytes = [int64]$raw.DiskReadBytesPersec
        $nowAt    = Get-Date
        $rate = 0
        if ($script:_lastDiskReadAt -ne [datetime]::MinValue) {
            $dt = ($nowAt - $script:_lastDiskReadAt).TotalSeconds
            if ($dt -gt 0) {
                $rate = [int64](($nowBytes - $script:_lastDiskReadBytes) / $dt)
                if ($rate -lt 0) { $rate = 0 }
            }
        }
        $script:_lastDiskReadBytes = $nowBytes
        $script:_lastDiskReadAt    = $nowAt
        return $rate
    } catch { return 0 }
}

function Invoke-OneBenchRun {
    # Execute one warmup-then-bench cycle for $item: spawn llama-server,
    # wait for ready, optional warmup, bench, parse stderr, tear down.
    # Returns a per-run hashtable (measurements + parsed-stderr fields).
    # No caching, no top-level identity fields, no JSON write. Appends to
    # $logFile so a multi-run session has a single log with run delimiters.
    param($item, $cfg, [int]$runIndex, [string]$logFile)

    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400

    Start-LinuxGpuMonitor   # stream radeontop for live VRAM/util (no-op off Linux / no radeontop)

    $exe   = $cfg.llama_server_exe
    $port  = [int]$cfg.bench.port
    $nPred = [int]$cfg.bench.n_predict
    $prompt= $cfg.bench.prompt

    $argStr = "-m `"$($item.model_path)`""
    if ($item.mmproj_path) { $argStr += " --mmproj `"$($item.mmproj_path)`"" }
    $argStr += " $($item.extra_args) --port $port --host 127.0.0.1 --no-warmup --cache-ram 128"

    $gpuBaseline = Get-GpuSnapshot
    $vramBefore = $gpuBaseline.mem_mib
    $sharedBaseline = if ($cfg.wddm_detection.enable_shared_mem_counter) { Get-SharedGPUMemoryMib } else { 0 }
    if ($sharedBaseline -lt 0) { $sharedBaseline = 0 }
    $ramBaseline = Get-AvailableMemoryMib   # MiB free before load

    "===== RUN $runIndex =====" | Out-File -Encoding utf8 -Append $logFile
    "[CMD] $exe $argStr" | Out-File -Encoding utf8 -Append $logFile
    "[VRAM before: $vramBefore MiB; shared baseline: $sharedBaseline MiB; RAM avail: $ramBaseline MiB]" | Out-File -Encoding utf8 -Append $logFile

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argStr
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow  = $true

    $loadStart = Get-Date
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()

    # Phase marker: CLI uses these to drive the per-run flow widget. Grep-
    # stable single-word state name. See RunView's PHASE_RE / RUN_PHASES.
    Write-Host "[phase] loading_model"

    $deadline = (Get-Date).AddSeconds([int]$cfg.bench.wait_sec_ready)
    $ready = $false
    $peakVram = $vramBefore
    $peakShared = 0
    $peakPower = 0.0
    $peakTemp = 0
    $utilSum = 0
    $utilCount = 0
    $minRam = $ramBaseline       # min available => peak used
    $peakDiskRead = 0            # bytes/sec, load phase only
    $wc = New-Object System.Net.WebClient
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Milliseconds 500
        if ($MinimalPolling) {
            # Cheap path: just VRAM + readiness check, no power/temp/util/RAM/disk.
            # Skips the [poll] emit entirely; the CLI's live strip stays blank.
            # Get-GpuSnapshot wraps nvidia-smi in try/catch and falls back to
            # sysfs on Linux, so this never throws when nvidia-smi is absent.
            $vNow = (Get-GpuSnapshot).mem_mib
            if ($vNow -gt $peakVram) { $peakVram = $vNow }
            if ($cfg.wddm_detection.enable_shared_mem_counter) {
                $s = Get-SharedGPUMemoryMib
                if ($s -ge 0) {
                    $delta = $s - $sharedBaseline
                    if ($delta -gt $peakShared) { $peakShared = $delta }
                }
            }
        } else {
            $snap = Get-GpuSnapshot
            if ($snap.mem_mib  -gt $peakVram)  { $peakVram  = $snap.mem_mib }
            if ($snap.power_w  -gt $peakPower) { $peakPower = $snap.power_w }
            if ($snap.temp_c   -gt $peakTemp)  { $peakTemp  = $snap.temp_c }
            if ($snap.util_pct -ge 0) { $utilSum += $snap.util_pct; $utilCount++ }
            if ($cfg.wddm_detection.enable_shared_mem_counter) {
                $s = Get-SharedGPUMemoryMib
                if ($s -ge 0) {
                    $delta = $s - $sharedBaseline
                    if ($delta -gt $peakShared) { $peakShared = $delta }
                }
            }
            $ramNow = Get-AvailableMemoryMib
            if ($ramNow -ge 0 -and ($minRam -lt 0 -or $ramNow -lt $minRam)) { $minRam = $ramNow }
            $diskNow = Get-DiskReadBytesPerSec
            if ($diskNow -gt $peakDiskRead) { $peakDiskRead = $diskNow }
            # Live poll marker for the CLI's real-time strip. Structured
            # key=value, grep-stable, filtered from the visible log on the
            # CLI side. Floats formatted with InvariantCulture so the
            # decimal point is always '.' (PowerShell on Italian Windows
            # would otherwise emit '42,14' and the JS parser would
            # Number("42,14") -> NaN -> 0 on the CLI).
            $ramUsedNow = if ($ramBaseline -ge 0 -and $ramNow -ge 0) { $ramBaseline - $ramNow } else { 0 }
            $diskMBNow  = [math]::Round($diskNow / 1MB, 1)
            $inv = [System.Globalization.CultureInfo]::InvariantCulture
            $powStr  = $snap.power_w.ToString($inv)
            $diskStr = $diskMBNow.ToString($inv)
            Write-Host ("[poll] gpu_mem={0} gpu_pow={1} gpu_temp={2} gpu_util={3} ram_used={4} disk_r={5}" -f $snap.mem_mib, $powStr, $snap.temp_c, $snap.util_pct, $ramUsedNow, $diskStr)
        }
        try {
            $content = $wc.DownloadString("http://127.0.0.1:$port/v1/models")
            if ($content.Length -gt 10) { $ready = $true; break }
        } catch { }
    }
    $wc.Dispose()
    $loadSec = [math]::Round(((Get-Date) - $loadStart).TotalSeconds, 2)

    if ($ready) { Write-Host "[phase] server_ready" }

    $run = [ordered]@{
        run_index       = $runIndex
        timestamp       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        vram_before_mib = $vramBefore
        vram_peak_mib   = $peakVram
        shared_peak_mib = $peakShared
        load_sec        = $loadSec
        ready           = $ready
        ok              = $false
        error           = $null
        # Extended metrics (added in v0.1.3). Defaults are sensible
        # null/zero so the schema stays uniform across all runs.
        ttft_sec             = $null   # set after the bench POST returns
        gpu_power_peak_w     = [math]::Round($peakPower, 1)
        gpu_temp_peak_c      = $peakTemp
        gpu_util_avg_pct     = if ($utilCount -gt 0) { [int]($utilSum / $utilCount) } else { 0 }
        ram_baseline_mib     = $ramBaseline
        ram_used_peak_mib    = if ($ramBaseline -ge 0 -and $minRam -ge 0) { [int]($ramBaseline - $minRam) } else { 0 }
        disk_read_peak_mb_s  = [math]::Round($peakDiskRead / 1MB, 1)
    }

    if ($ready) {
        # We talk to /v1/chat/completions instead of /completion so llama-server
        # applies the chat template baked into the GGUF (Jinja). /completion
        # tokenizes the prompt raw - fine for Llama/Qwen which are forgiving,
        # but Granite ships a structured system prompt and Gemma 4 uses
        # asymmetric turn markers (<|turn> / <turn|>); both never generate
        # anything sensible without the template, and the bench then records
        # "unsupported architecture" / "server didn't become ready" instead
        # of a real measurement. Same `timings` field (prompt_n,
        # prompt_per_second, predicted_n, predicted_per_second, prompt_ms) is
        # returned by llama-server on this endpoint too, so the metric
        # pipeline below is untouched.
        if ($cfg.bench.warmup) {
            try {
                $warmupReq = @{
                    messages    = @(@{ role = 'user'; content = $prompt })
                    max_tokens  = 8
                    temperature = 0.0
                    stream      = $false
                    cache_prompt = $true
                }
                if ($item.reasoning_mode -eq "off") { $warmupReq["enable_thinking"] = $false }
                $wBody = $warmupReq | ConvertTo-Json -Compress -Depth 5
                Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/chat/completions" -Method Post -Body $wBody -ContentType "application/json" -TimeoutSec 300 | Out-Null
            } catch { }
        }

        $reqBody = @{
            messages    = @(@{ role = 'user'; content = $prompt })
            max_tokens  = $nPred
            temperature = 0.0
            stream      = $false
            cache_prompt = $false
        }
        if ($item.reasoning_mode -eq "off") { $reqBody["enable_thinking"] = $false }
        $body = $reqBody | ConvertTo-Json -Compress -Depth 5
        Write-Host "[phase] sending_prompt"
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/chat/completions" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 900
            $run.ok = $true
            if ($resp.timings) {
                $run.prompt_n   = $resp.timings.prompt_n
                $run.prompt_tps = [math]::Round($resp.timings.prompt_per_second, 2)
                $run.eval_n     = $resp.timings.predicted_n
                # eval_tps guard: when the model emits ~1 token (e.g. it hits
                # EOS immediately on a bare prompt), predicted_ms rounds to 0
                # and llama.cpp returns predicted_per_second = 1000000 - a
                # sentinel, not a real speed. Recording it blows out the report
                # (bar-chart scale, winner pick). Treat <2 tokens or zero time
                # as unmeasured (null) instead.
                $predN  = [int]$resp.timings.predicted_n
                $predMs = if ($null -ne $resp.timings.predicted_ms) { [double]$resp.timings.predicted_ms } else { 0 }
                if ($predN -ge 2 -and $predMs -gt 0) {
                    $run.eval_tps = [math]::Round($resp.timings.predicted_per_second, 2)
                } else {
                    $run.eval_tps = $null   # unmeasured: too few tokens to time
                }
                # Time-to-first-token: llama.cpp reports prompt_ms (total
                # time spent processing the input prompt). The first
                # generated token comes out immediately after, so prompt_ms
                # is effectively the felt latency before the model
                # responds. Dominates total time for long prompts because
                # prompt eval is O(N^2) in input length.
                if ($null -ne $resp.timings.prompt_ms) {
                    $run.ttft_sec = [math]::Round([double]$resp.timings.prompt_ms / 1000, 3)
                }
            }
        } catch { $run.error = $_.Exception.Message }

        # Post-bench snapshot: grabs peaks of GPU/RAM at the moment the model
        # is hottest (the bench POST is synchronous, so we don't poll during
        # it; this single snapshot captures the steady-state load right
        # after). Background-thread polling during the POST would be more
        # accurate but adds significant complexity for marginal gain.
        $snap = Get-GpuSnapshot
        # On Linux the streamed radeontop dump can lag behind on a fast bench;
        # take one accurate one-shot read at this peak moment (the server is
        # still up, so the model is still resident on the GPU).
        $vramSnap = $snap.mem_mib
        $vramFresh = Get-LinuxGpuVramFresh
        if ($vramFresh -ge 0) { $vramSnap = $vramFresh }
        if ($vramSnap     -gt $run.vram_peak_mib)        { $run.vram_peak_mib       = $vramSnap }
        if ($snap.power_w  -gt $run.gpu_power_peak_w)     { $run.gpu_power_peak_w    = [math]::Round($snap.power_w, 1) }
        if ($snap.temp_c   -gt $run.gpu_temp_peak_c)      { $run.gpu_temp_peak_c     = $snap.temp_c }
        if ($cfg.wddm_detection.enable_shared_mem_counter) {
            $s = Get-SharedGPUMemoryMib
            if ($s -ge 0) {
                $delta = $s - $sharedBaseline
                if ($delta -gt $run.shared_peak_mib) { $run.shared_peak_mib = $delta }
            }
        }
        $ramNow = Get-AvailableMemoryMib
        if ($ramBaseline -ge 0 -and $ramNow -ge 0) {
            $usedNow = $ramBaseline - $ramNow
            if ($usedNow -gt $run.ram_used_peak_mib) { $run.ram_used_peak_mib = [int]$usedNow }
        }
    }

    if (-not $p.HasExited) { try { $p.Kill() } catch { } }
    Stop-LinuxGpuMonitor
    Start-Sleep -Milliseconds 700
    try { $err = $errTask.GetAwaiter().GetResult() } catch { $err = "" }

    "`n===== STDERR (run $runIndex) =====" | Out-File -Encoding utf8 -Append $logFile
    $err | Out-File -Encoding utf8 -Append $logFile

    $patterns = @{
        cpu_model_mib    = 'CPU model buffer size\s*=\s*([\d\.]+)'
        cuda_model_mib   = 'CUDA0 model buffer size\s*=\s*([\d\.]+)'
        kv_cache_mib     = 'CUDA0 KV buffer size\s*=\s*([\d\.]+)'
        compute_cuda_mib = 'CUDA0 compute buffer size\s*=\s*([\d\.]+)'
        compute_host_mib = 'CUDA_Host compute buffer size\s*=\s*([\d\.]+)'
        layers_offloaded = 'offloaded (\d+)/(\d+) layers'
    }
    foreach ($k in $patterns.Keys) {
        $m = [regex]::Match($err, $patterns[$k])
        if ($m.Success) {
            if ($k -eq 'layers_offloaded') { $run[$k] = "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }
            else { $run[$k] = [double]$m.Groups[1].Value }
        }
    }
    # Trap llama.cpp builds that don't recognize a model's architecture (e.g.
    # an older build vs. a brand-new lineage). Surface the architecture name
    # so the caller can short-circuit further tests on the same model.
    $mArch = [regex]::Match($err, "unknown model architecture: '([^']+)'")
    if ($mArch.Success) { $run.unsupported_architecture = $mArch.Groups[1].Value }
    if ($err -match 'successfully fit params') { $run.fit_status = "success" }
    elseif ($err -match 'failed to fit params') { $run.fit_status = "failed_but_running" }
    else { $run.fit_status = "unknown" }

    $vramTotal = if ($null -ne $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $satRatio = if ($vramTotal -gt 0) { $run.vram_peak_mib / $vramTotal } else { 0 }
    $run.wddm_vram_saturation = [math]::Round($satRatio, 3)
    $run.wddm_flag_high_vram  = ($satRatio -gt $cfg.wddm_detection.vram_saturation_threshold)
    $confirmThresh = if ($cfg.wddm_detection.shared_delta_confirm_mib) { [int]$cfg.wddm_detection.shared_delta_confirm_mib } else { 500 }
    $run.wddm_flag_shared_pos = ($run.shared_peak_mib -gt $confirmThresh)

    Write-Host "[phase] run_complete"
    return $run
}

function Invoke-OneBench {
    # Drive N runs of a single planning $item and persist one result file.
    # Cache check follows spec/n-run-median.md "Cache invalidation": failed
    # results are cached as-is (definitive negative); successful results
    # need a `runs` array of length N to be cache-hits; pre-v1.1.0 success
    # files (no `runs` array) are treated as length-one for `-Runs 1` only.
    # On any single-run failure, writes the existing single-record failure
    # JSON (no `runs` array) and returns immediately; preserves the v1.0.0
    # unsupported_architecture short-circuit.
    param($item, $cfg)

    $jsonFile = Join-Path $CALIBR_RESULTS_DIR "$($item.id).json"
    $logFile  = Join-Path $CALIBR_LOGS_DIR    "$($item.id).log"
    $confirmMibLocal = if ($cfg.wddm_detection -and $null -ne $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }

    # Pre-flight: the model .gguf (and its mmproj, if any) must exist on disk.
    # When a model was rotated/deleted but the catalog/plan still reference it,
    # llama-server just exits with "No such file or directory" and the run
    # surfaces as the opaque "server didn't become ready". Catch it up front and
    # fail with an actionable reason. Not cached (the file may come back via
    # re-download); we re-check on every bench.
    $missingFiles = @()
    if (-not (Test-Path -LiteralPath $item.model_path)) { $missingFiles += $item.model_path }
    if ($item.mmproj_path -and -not (Test-Path -LiteralPath $item.mmproj_path)) { $missingFiles += $item.mmproj_path }
    if ($missingFiles.Count -gt 0) {
        $failResult = [ordered]@{
            id = $item.id; label = $item.label; model = $item.model; variant = $item.variant
            series = $item.series; level = $item.level; sweep = $item.sweep
            reasoning_mode = $item.reasoning_mode; template_note = $item.template_note
            gguf_context_length = $item.gguf_context_length; gguf_architecture = $item.gguf_architecture
            timestamp = (Get-Date).ToUniversalTime().ToString('o')
            model_path = $item.model_path; mmproj_path = $item.mmproj_path
            extra_args = $item.extra_args
            vram_before_mib = $null; vram_peak_mib = $null; shared_peak_mib = $null
            load_sec = $null; ready = $false; ok = $false
            error = "model file(s) not found on disk: " + ($missingFiles -join ', ')
            fit_status = $null; unsupported_architecture = $null
            failure_reason = 'model_missing'
            bench_session_id         = if ($script:BENCH_SESSION_ID)         { $script:BENCH_SESSION_ID }         else { 'unknown' }
            bench_session_started_at = if ($script:BENCH_SESSION_STARTED_AT) { $script:BENCH_SESSION_STARTED_AT } else { '' }
            llama_server_version     = if ($script:LLAMA_SERVER_VERSION)     { $script:LLAMA_SERVER_VERSION }     else { 'unknown' }
            llama_server_exe         = if ($cfg.llama_server_exe)            { $cfg.llama_server_exe }            else { '' }
        }
        # Don't persist a results JSON: this is an environment problem, not a
        # benchmark negative, so a later re-download + bench should just retry.
        if (Test-Path $jsonFile) { Remove-Item -LiteralPath $jsonFile -Force -ErrorAction SilentlyContinue }
        Write-BenchStatusLine -item $item -result $failResult
        return $failResult
    }

    # Resolve N: CLI flag > config > default 3. Minimum 1.
    $N = if ($Runs -gt 0) { $Runs }
         elseif ($null -ne $cfg.bench.runs_per_config) { [int]$cfg.bench.runs_per_config }
         else { 3 }
    if ($N -lt 1) { $N = 1 }

    # Cache check
    if ((Test-Path $jsonFile) -and (-not $Force)) {
        $cached = Get-Content $jsonFile -Raw | ConvertFrom-Json
        if (-not $cached.ok) {
            # Cached failure: re-run automatically when the recorded
            # llama_server_version differs from the current build. Otherwise
            # the user gets stuck seeing yesterday's "unsupported_arch" forever
            # even after upgrading llama.cpp. Same-version failures stay
            # cached (definitive negative on the current binary).
            # Pre-v0.1.6 result JSONs lack the field; treat them as 'unknown'
            # so they always differ from a known current version and re-run.
            $cachedVer = if ($cached.PSObject.Properties.Name -contains 'llama_server_version') { [string]$cached.llama_server_version } else { 'unknown' }
            if ($cachedVer -ne $script:LLAMA_SERVER_VERSION) {
                Write-Host ("[{0}] cached failure from llama-server {1}, current is {2} - re-running" -f $item.id, $cachedVer, $script:LLAMA_SERVER_VERSION) -ForegroundColor DarkYellow
            } else {
                Write-Host ("[{0}] cached failure (use -Force to retry)" -f $item.id) -ForegroundColor DarkGray
                return $cached
            }
        } else {
            if ($null -ne $cached.runs -and $cached.runs.Count -eq $N) {
                Write-Host ("[{0}] cached N={1} (use -Force to rerun)" -f $item.id, $N) -ForegroundColor DarkGray
                return $cached
            }
            if ($null -eq $cached.runs -and $N -eq 1) {
                Write-Host ("[{0}] cached legacy N=1 (use -Force to rerun)" -f $item.id) -ForegroundColor DarkGray
                return $cached
            }
            $haveN = if ($null -ne $cached.runs) { $cached.runs.Count } else { 0 }
            Write-Host ("[{0}] cache miss (have N={1}, want N={2}) - re-running" -f $item.id, $haveN, $N) -ForegroundColor DarkGray
        }
    }

    # Fresh log for this bench session
    Set-Content -Encoding utf8 -Path $logFile -Value ""

    $runs = @()
    for ($i = 0; $i -lt $N; $i++) {
        if ($N -gt 1) {
            Write-Host ("  run {0}/{1}" -f ($i + 1), $N) -ForegroundColor DarkGray
        }
        $r = Invoke-OneBenchRun -item $item -cfg $cfg -runIndex $i -logFile $logFile

        if (-not $r.ok) {
            # Single-record failure shape (no `runs` array): definitive
            # negative cached as-is. Preserves the v1.0.0 model-skip path.
            $failResult = [ordered]@{
                id              = $item.id
                label           = $item.label
                model           = $item.model
                variant         = $item.variant
                series          = $item.series
                level           = $item.level
                sweep           = $item.sweep
                reasoning_mode  = $item.reasoning_mode
                template_note   = $item.template_note
                gguf_context_length = $item.gguf_context_length
                gguf_architecture = $item.gguf_architecture
                timestamp       = $r.timestamp
                model_path      = $item.model_path
                mmproj_path     = $item.mmproj_path
                extra_args      = $item.extra_args
                vram_before_mib = $r.vram_before_mib
                vram_peak_mib   = $r.vram_peak_mib
                shared_peak_mib = $r.shared_peak_mib
                load_sec        = $r.load_sec
                ready           = $r.ready
                ok              = $false
                error           = $r.error
                cpu_model_mib   = $r.cpu_model_mib
                cuda_model_mib  = $r.cuda_model_mib
                kv_cache_mib    = $r.kv_cache_mib
                compute_cuda_mib = $r.compute_cuda_mib
                compute_host_mib = $r.compute_host_mib
                layers_offloaded = $r.layers_offloaded
                fit_status      = $r.fit_status
                unsupported_architecture = $r.unsupported_architecture
                wddm_vram_saturation = $r.wddm_vram_saturation
                wddm_flag_high_vram  = $r.wddm_flag_high_vram
                wddm_flag_shared_pos = $r.wddm_flag_shared_pos
                # Extended metrics carry through to the failure record too
                # so the report can render the same columns uniformly
                # whether ok=true or ok=false.
                ttft_sec             = $r.ttft_sec
                gpu_power_peak_w     = $r.gpu_power_peak_w
                gpu_temp_peak_c      = $r.gpu_temp_peak_c
                gpu_util_avg_pct     = $r.gpu_util_avg_pct
                ram_baseline_mib     = $r.ram_baseline_mib
                ram_used_peak_mib    = $r.ram_used_peak_mib
                disk_read_peak_mb_s  = $r.disk_read_peak_mb_s
                # Session + llama-server identity (matches the success record
                # in New-AggregatedBenchResult). Drives the report's
                # latest-session filter and the cache's version-aware retry.
                bench_session_id         = if ($script:BENCH_SESSION_ID)         { $script:BENCH_SESSION_ID }         else { 'unknown' }
                bench_session_started_at = if ($script:BENCH_SESSION_STARTED_AT) { $script:BENCH_SESSION_STARTED_AT } else { '' }
                llama_server_version     = if ($script:LLAMA_SERVER_VERSION)     { $script:LLAMA_SERVER_VERSION }     else { 'unknown' }
                llama_server_exe         = if ($cfg.llama_server_exe)            { $cfg.llama_server_exe }            else { '' }
            }
            $failResult.failure_reason = Get-FailureReason -result $failResult -sharedConfirmMib $confirmMibLocal
            $failResult | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile
            Write-BenchStatusLine -item $item -result $failResult
            return $failResult
        }

        $runs += $r
    }

    $aggregated = New-AggregatedBenchResult -item $item -cfg $cfg -runs $runs
    # All N runs succeeded so failure_reason is unset (null). Recording it as
    # null (rather than omitting) keeps every result's schema identical, which
    # simplifies report.template.html's column rendering.
    $aggregated.failure_reason = Get-FailureReason -result $aggregated -sharedConfirmMib $confirmMibLocal
    $aggregated | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile
    Write-BenchStatusLine -item $item -result $aggregated
    return $aggregated
}

function Write-BenchStatusLine {
    # Print the per-config result line. Identical wording to v1.0.x; the
    # numbers shown are now medians for successful N>1 results. Pure
    # presentation; no return value.
    param($item, $result)
    $tag = if ($result.ok) { "[OK]  " } else { "[FAIL]" }
    $tagColor = if ($result.ok) { 'Green' } else { 'Red' }
    if ($result.ok) {
        $detail = "prompt={0,6}t/s   eval={1,5}t/s   peak={2} MiB" -f $result.prompt_tps, $result.eval_tps, $result.vram_peak_mib
        if ($result.wddm_flag_shared_pos)    { $detail += "   [WDDM: shared=+$($result.shared_peak_mib)MiB]" }
        elseif ($result.wddm_flag_high_vram) { $detail += "   [WDDM: VRAM $([int]($result.wddm_vram_saturation*100))%]" }
    } elseif ($result.failure_reason -eq 'model_missing') {
        $detail = "(model file missing - re-download with get-models, or run discover to drop it)"
    } elseif ($result.unsupported_architecture) {
        $detail = "(unsupported architecture: $($result.unsupported_architecture))"
    } elseif (-not $result.ready) {
        $detail = "(server didn't become ready)"
    } else {
        $detail = "(completion failed)"
    }
    Write-Host ("{0} {1,-55} {2}" -f $tag, $item.label, $detail) -ForegroundColor $tagColor
}

function Get-FailureReason {
    # Classify why a bench result is not ok into one of four buckets so
    # downstream code (rotation, abandonment, reports) can act on it
    # without re-parsing scattered signals. Returns one of:
    #   vram_overflow      - WDDM paged into shared memory; the model
    #                        couldn't fit in real VRAM. fit_status said
    #                        'failed_but_running' OR shared_peak crossed
    #                        the confirm threshold.
    #   server_timeout     - llama-server never became ready in time, but
    #                        no VRAM-pressure signal fired. Build/CUDA bug,
    #                        broken model file, port conflict, etc.
    #   unsupported_arch   - the v1.0 short-circuit: llama.cpp doesn't
    #                        know this architecture yet (update llama.cpp).
    #   other              - catch-all for $result.ok=false without any
    #                        of the above signals.
    # Returns $null when $result.ok is true (no failure to classify).
    param($result, [int]$sharedConfirmMib = 500)
    if ($null -eq $result) { return $null }
    if ($result.ok) { return $null }
    if ($result.unsupported_architecture) { return "unsupported_arch" }
    $shared = if ($null -ne $result.shared_peak_mib) { [int]$result.shared_peak_mib } else { 0 }
    if ($result.fit_status -eq "failed_but_running" -or $shared -gt $sharedConfirmMib) {
        return "vram_overflow"
    }
    if ($result.ready -eq $false) { return "server_timeout" }
    return "other"
}

function Select-PlanForBench {
    # Pure filter: applies the same -Model/-Level/-Id rules Invoke-Bench uses,
    # returns an array (possibly empty). The leading `$_ -and` is load-bearing:
    # PowerShell's `$null | Where-Object` yields one $null item, and @() wraps
    # it to a 1-element array, which would then crash the rotation context
    # build with ContainsKey($null). The same pattern protects against any
    # other malformed plan entry that managed to become $null mid-pipeline.
    param(
        $plan,
        [string]$ModelFilter = "",
        [string]$LevelFilter = "",
        [string]$IdFilter = ""
    )
    return ,@($plan | Where-Object {
        $_ -and
        (-not $ModelFilter -or $_.model -match $ModelFilter) -and
        (-not $LevelFilter -or $_.level -eq $LevelFilter) -and
        (-not $IdFilter    -or $_.id    -like $IdFilter)
    })
}

function Get-DownloadRetentionPolicy {
    if ($KeepDownloads) { return "keep-all" }
    if ($DownloadRetention) { return $DownloadRetention }
    return "cleanup"
}

function Get-RetentionCandidates {
    if ($null -eq $script:_downloadRetentionCandidates) {
        $script:_downloadRetentionCandidates = @{}
    }
    return $script:_downloadRetentionCandidates
}

function Add-RetentionCandidate {
    param(
        [Parameter(Mandatory)][string]$ModelPath,
        [string]$ModelName = "",
        [string]$MmprojPath = ""
    )
    $candidates = Get-RetentionCandidates
    if (-not $candidates.ContainsKey($ModelPath)) {
        $candidates[$ModelPath] = @{
            modelPath    = $ModelPath
            modelName    = $ModelName
            mmprojPath   = $MmprojPath
            lastDecision = ""
        }
    }
}

function Get-TopRetainedDownloadPaths {
    param([Parameter(Mandatory)][int]$TopN)
    $keep = @{}
    $candidates = Get-RetentionCandidates
    if ($candidates.Count -eq 0) { return $keep }

    $cfg = Get-Config
    $confirmMib = if ($cfg.wddm_detection -and $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }

    $bestByPath = @{}
    foreach ($jsonFile in (Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" -ErrorAction SilentlyContinue)) {
        try {
            $r = Get-Content $jsonFile.FullName -Raw | ConvertFrom-Json
        } catch { continue }
        if (-not $r.ok -or -not $r.model_path) { continue }
        if (-not $candidates.ContainsKey([string]$r.model_path)) { continue }
        $path = [string]$r.model_path
        if (Test-IsBetterWinner -candidate $r -current $bestByPath[$path] -preferSpeed:$PreferSpeed -sharedConfirmMib $confirmMib) {
            $bestByPath[$path] = $r
        }
    }

    $ranked = @($bestByPath.GetEnumerator() | Sort-Object `
        @{ Expression = { if ($PreferSpeed) { 0 } elseif ([int]$_.Value.shared_peak_mib -le $confirmMib) { 1 } else { 0 } }; Descending = $true }, `
        @{ Expression = { if ($null -ne $_.Value.eval_tps) { [double]$_.Value.eval_tps } else { -1 } }; Descending = $true })

    foreach ($entry in @($ranked | Select-Object -First $TopN)) {
        $keep[[string]$entry.Key] = $true
    }
    return $keep
}

function Remove-DownloadedArtifacts {
    param(
        [Parameter(Mandatory)][string]$ModelPath,
        [string]$MmprojPath = "",
        $filtered,
        [hashtable]$modelStatus,
        [ref]$rotatedRef,
        [string]$Reason = ""
    )

    if (Test-Path -LiteralPath $ModelPath) {
        try {
            Remove-Item -LiteralPath $ModelPath -Force -ErrorAction Stop
            $suffix = if ($Reason) { " ($Reason)" } else { "" }
            Write-Host ("[rotate] deleted {0}{1}" -f $ModelPath, $suffix) -ForegroundColor DarkCyan
            Remove-DownloadManifestEntry -ModelPath $ModelPath
            if ($rotatedRef) { $rotatedRef.Value++ }
        } catch {
            Write-Host ("[rotate] FAILED to delete {0}: {1}" -f $ModelPath, $_.Exception.Message) -ForegroundColor Red
            return $false
        }
    }

    if ($MmprojPath) {
        $stillNeeded = $false
        foreach ($other in $filtered) {
            if ($other.model_path -eq $ModelPath) { continue }
            if ($other.mmproj_path -ieq $MmprojPath) {
                $otherSt = $modelStatus[$other.model_path]
                if ($otherSt -and -not $otherSt.rotated) {
                    $stillNeeded = $true
                    break
                }
            }
        }
        foreach ($candidate in (Get-RetentionCandidates).Values) {
            if ($candidate.modelPath -eq $ModelPath) { continue }
            if ($candidate.mmprojPath -and $candidate.mmprojPath -ieq $MmprojPath -and (Test-Path -LiteralPath $candidate.modelPath)) {
                $stillNeeded = $true
                break
            }
        }
        if (-not $stillNeeded -and (Test-Path -LiteralPath $MmprojPath)) {
            try {
                Remove-Item -LiteralPath $MmprojPath -Force -ErrorAction Stop
                Write-Host ("[rotate] deleted {0} (mmproj)" -f $MmprojPath) -ForegroundColor DarkCyan
            } catch {
                Write-Host ("[rotate] FAILED to delete mmproj {0}: {1}" -f $MmprojPath, $_.Exception.Message) -ForegroundColor Red
            }
        }
    }

    $parentDir = [System.IO.Path]::GetDirectoryName($ModelPath)
    if ($parentDir -and (Test-Path -LiteralPath $parentDir)) {
        try {
            $info = New-Object System.IO.DirectoryInfo($parentDir)
            if ($info.GetFileSystemInfos().Length -eq 0) {
                $info.Delete()
            }
        } catch { }
    }
    return $true
}

function Invoke-TopRetentionPrune {
    param(
        [Parameter(Mandatory)][int]$TopN,
        $filtered,
        [hashtable]$modelStatus,
        [ref]$rotatedRef,
        [ref]$keptRef
    )
    $candidates = Get-RetentionCandidates
    if ($candidates.Count -eq 0) { return }
    $top = Get-TopRetainedDownloadPaths -TopN $TopN
    foreach ($path in @($candidates.Keys)) {
        $entry = $candidates[$path]
        if ($top.ContainsKey($path)) {
            if ($entry.lastDecision -ne "kept") {
                Write-Host ("[rotate] kept {0} (top {1})" -f $path, $TopN) -ForegroundColor DarkGray
                Remove-DownloadManifestEntry -ModelPath $path
                $keptRef.Value++
                $entry.lastDecision = "kept"
            }
            continue
        }
        if (Remove-DownloadedArtifacts -ModelPath $path -MmprojPath $entry.mmprojPath -filtered $filtered -modelStatus $modelStatus -rotatedRef $rotatedRef -Reason "outside top $TopN") {
            $candidates.Remove($path)
        }
    }
}

function Invoke-RotationCheck {
    # Called once per config-iteration in Invoke-Bench. If $item's model_path
    # has reached its expected config count, deletes the .gguf and possibly
    # its mmproj and emits a host line, or keeps and skips silently.
    #
    # Policy is intentionally simple: a file calibr fetched into a temporary
    # location lives only as long as we need it for the bench. Once every
    # config for that model has been accounted for (ok, fail, or skip), we
    # delete the file regardless of outcome. Reasons:
    #   - the per-config result JSONs (and logs) are persisted separately
    #     and are the actual evidence the user might want for debugging;
    #     the .gguf itself has no diagnostic value
    #   - keeping a file that's never going to be benched again wastes disk
    #     for nothing (the original peak-bounded promise of rotation)
    #
    # The only reasons we KEEP are still explicit:
    #   - retention policy says keep-all / keep-top-1 / keep-top-3
    #   - file is not in the download manifest (user-owned; never touched)
    #
    # mmproj is deleted only when no other not-yet-rotated model in $filtered
    # still references it on disk. Avoids breaking a later same-bench config
    # of a sibling variant that happens to share the projector file.
    param(
        $item,
        [hashtable]$modelStatus,
        $filtered,
        [ref]$rotatedRef,
        [ref]$keptRef
    )
    $mp = $item.model_path
    $st = $modelStatus[$mp]
    if (-not $st) { return }
    if ($st.done -ne $st.needed) { return }
    if ($st.rotated) { return }
    $st.rotated = $true

    if (-not (Test-DownloadedByCalibr -Path $mp)) {
        # Silent for user-owned files; printing for every model would spam.
        $keptRef.Value++
        return
    }

    $policy = Get-DownloadRetentionPolicy
    if ($policy -eq "keep-all") {
        Write-Host ("[rotate] kept {0} (keep-all)" -f $mp) -ForegroundColor DarkGray
        Remove-DownloadManifestEntry -ModelPath $mp
        $keptRef.Value++
        return
    }

    if ($policy -eq "keep-top-1" -or $policy -eq "keep-top-3") {
        Add-RetentionCandidate -ModelPath $mp -ModelName $st.modelName -MmprojPath $st.mmprojPath
        $topN = if ($policy -eq "keep-top-1") { 1 } else { 3 }
        Invoke-TopRetentionPrune -TopN $topN -filtered $filtered -modelStatus $modelStatus -rotatedRef $rotatedRef -keptRef $keptRef
        return
    }

    [void](Remove-DownloadedArtifacts -ModelPath $mp -MmprojPath $st.mmprojPath -filtered $filtered -modelStatus $modelStatus -rotatedRef $rotatedRef)
}

function Invoke-Bench {
    $cfg = Get-Config
    # Reconcile with disk before reading the plan: a model rotated/deleted since
    # the last discover would otherwise be benched against a phantom file.
    $phantoms = Remove-PhantomEntries
    if ($phantoms -gt 0) {
        Write-Host ("[reconcile] dropped {0} model(s) no longer on disk (re-add with get-models)" -f $phantoms) -ForegroundColor DarkYellow
    }
    if (-not (Test-Path $CALIBR_PLAN)) { throw "plan.json missing. Run 'calibr plan'." }
    $planRaw = Get-Content $CALIBR_PLAN -Raw | ConvertFrom-Json
    $plan = ConvertTo-Hashtable -obj $planRaw

    Write-Host "=== bench ===" -ForegroundColor Cyan

    # Cheap early exit: if the plan is empty (typical of an 'all
    # -FetchCatalog' phase 0 on a fresh machine where discover found no
    # pre-existing .gguf), there's nothing to bench and no reason to
    # require llama_server_exe yet. Surface a friendly hint instead of
    # throwing. The later per-sample iterations of the 'all' loop will
    # re-enter this function with a populated plan.
    $planCount = if ($plan) { @($plan).Count } else { 0 }
    if ($planCount -eq 0) {
        Write-Host "Plan is empty. Run 'calibr discover' (with .gguf files in scan_paths) then 'calibr plan' first." -ForegroundColor Yellow
        return
    }

    # Now we actually need llama-server. Validate before the bench loop
    # so the failure points at the real fix ('run init') rather than
    # crashing inside Invoke-OneBench.
    if (-not $cfg.llama_server_exe -or -not (Test-Path $cfg.llama_server_exe)) {
        throw "llama_server_exe missing or invalid. Run 'calibr init' to detect and write it to config.json."
    }

    # Stamp session metadata on every result this bench writes. Idempotent
    # so 'all' (which calls Invoke-Bench in a per-sample loop) keeps one
    # session across all its inner invocations.
    Initialize-BenchSession -LlamaServerExe $cfg.llama_server_exe
    Write-Host ("bench session {0} . llama-server {1} . started {2}" -f $script:BENCH_SESSION_ID, $script:LLAMA_SERVER_VERSION, $script:BENCH_SESSION_STARTED_AT) -ForegroundColor DarkGray

    # Backend cross-check: detect available llama.cpp backends and warn if the
    # build doesn't match the GPU (e.g. NVIDIA card with a Vulkan-only build).
    $backends = Get-LlamaBackends -exe $cfg.llama_server_exe
    $availList = @($backends.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key } | Sort-Object)
    $availStr = if ($availList.Count -gt 0) { $availList -join ', ' } else { '(none)' }
    Write-Host ("llama.cpp backends available: {0}" -f $availStr) -ForegroundColor DarkGray
    foreach ($w in (Test-BackendHealthy -cfg $cfg -backends $backends)) {
        Write-Host "WARNING: $w" -ForegroundColor Yellow
    }

    $filtered = Select-PlanForBench -plan $plan -ModelFilter $Model -LevelFilter $Level -IdFilter $Id
    Write-Host ("{0} configs to run (filtered from {1})" -f $filtered.Count, $planCount)

    if ($filtered.Count -eq 0) {
        # planCount > 0 here (the planCount == 0 case returned earlier
        # before we even loaded llama-server). The user picked a filter
        # that no config in the plan matches - show the level breakdown so
        # they see WHY the filter missed.
        Write-Host "No configs match the current filter (-Model / -Level / -Id). Plan has $planCount configs total." -ForegroundColor Yellow
        $byLevel = @{}
        foreach ($p in $plan) {
            if (-not $p) { continue }
            $t = if ($p.level) { $p.level } else { "custom" }
            if (-not $byLevel.ContainsKey($t)) { $byLevel[$t] = @() }
            $byLevel[$t] += $p.model
        }
        foreach ($t in @('low','middle','high','ultra','custom')) {
            if (-not $byLevel.ContainsKey($t)) { continue }
            $modelsInLevel = @($byLevel[$t] | Sort-Object -Unique)
            $count = $byLevel[$t].Count
            $modelStr = if ($modelsInLevel.Count -gt 0) { " (" + ($modelsInLevel -join ', ') + ")" } else { "" }
            Write-Host ("  {0}: {1} config{2}{3}" -f $t, $count, $(if ($count -eq 1) {''} else {'s'}), $modelStr) -ForegroundColor DarkGray
        }
        if ($Level) {
            Write-Host ("Hint: drop '-Level {0}' to bench what's available, or run 'all -FetchCatalog -Preset {0}' to download + bench that level first." -f $Level) -ForegroundColor DarkGray
        }
        return
    }

    if ($DryRun) {
        $filtered | ForEach-Object { Write-Host ("  [{0}] {1}" -f $(if ($_.level) { $_.level } else { 'custom' }), $_.label) }
        return
    }

    $total      = $filtered.Count
    $startTime  = Get-Date
    $abandoned  = @{}
    $okCount    = 0
    $failCount  = 0
    $skipCount  = 0
    $i = 0
    # Threshold used by Get-FailureReason to decide vram_overflow vs other.
    # Mirrors the value used in Invoke-OneBenchRun / New-AggregatedBenchResult
    # for the WDDM flag so all three views agree.
    $confirmThresh = if ($cfg.wddm_detection -and $null -ne $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }

    # Rotation context: per-distinct-model_path tracking so we know when every
    # config touching a given .gguf is accounted for and can decide whether to
    # delete the file. We index by model_path (not model name) because the same
    # name could theoretically resolve to different files across scan paths.
    $modelStatus = @{}
    foreach ($item in $filtered) {
        $mp = $item.model_path
        if (-not $modelStatus.ContainsKey($mp)) {
            $modelStatus[$mp] = @{
                needed      = 0
                ok          = 0
                fail        = 0
                skip        = 0
                done        = 0
                modelName   = $item.model
                mmprojPath  = $item.mmproj_path
                rotated     = $false
            }
        }
        $modelStatus[$mp].needed++
    }
    $rotatedCount = 0
    $keptCount    = 0

    foreach ($item in $filtered) {
        $i++
        $mp = $item.model_path

        if ($abandoned.ContainsKey($item.model)) {
            $reason = $abandoned[$item.model]
            Write-Host ("[SKIP] {0,-55} ({1})" -f $item.label, $reason) -ForegroundColor DarkYellow
            $skipCount++
            $modelStatus[$mp].skip++
            $modelStatus[$mp].done++
            Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered $filtered -rotatedRef ([ref]$rotatedCount) -keptRef ([ref]$keptCount)
            continue
        }

        $elapsed = (Get-Date) - $startTime
        $etaStr = "?"
        if ($i -gt 1) {
            $etaSec = ($elapsed.TotalSeconds / ($i - 1)) * ($total - $i + 1)
            $etaStr = "{0}m{1:D2}s" -f ([int]($etaSec / 60)), ([int]($etaSec % 60))
        }
        $pct = if ($total -gt 0) { (($i - 1) / $total) * 100 } else { 0 }

        Write-Progress -Activity "calibr bench" `
                       -Status   "[$i/$total] running - ETA $etaStr" `
                       -CurrentOperation $item.label `
                       -PercentComplete $pct

        Write-Host ("`n[$i/$total] $($item.label)") -ForegroundColor Cyan
        $r = Invoke-OneBench -item $item -cfg $cfg
        if ($r.ok) {
            $okCount++
            $modelStatus[$mp].ok++
        } else {
            $failCount++
            $modelStatus[$mp].fail++
        }
        $modelStatus[$mp].done++

        if (-not $r.ok -and $r.unsupported_architecture) {
            $abandoned[$item.model] = "unsupported architecture '$($r.unsupported_architecture)'"
            Write-Host "  -> abandoning remaining tests for model '$($item.model)' (update llama.cpp to fix)" -ForegroundColor DarkYellow
        }

        # Sweep-aware abandonment on VRAM overflow. The context sweep raises
        # ctx ascending: if the smallest ctx already pages, larger ctxs make
        # it worse. The offload sweep raises gpu-layers ascending: if 20
        # already pages, 24..36 push even more onto the GPU. The moe-cpu sweep
        # raises n-cpu-moe ascending = MORE on CPU = LESS GPU pressure, so a
        # failure on 28 (most-on-GPU) does NOT predict failure on 36;
        # do not abandon a moe-cpu sweep on vram_overflow.
        if (-not $r.ok -and -not $abandoned.ContainsKey($item.model)) {
            $reason = Get-FailureReason -result $r -sharedConfirmMib $confirmThresh
            if ($reason -eq "vram_overflow" -and ($item.sweep -eq "context" -or $item.sweep -eq "offload")) {
                $abandoned[$item.model] = "vram overflow at smallest config in the $($item.sweep) sweep; larger configs will be worse"
                Write-Host ("  -> abandoning remaining {0}-sweep tests for model '{1}' (vram overflow detected; bigger ctx/ngl can only worsen it)" -f $item.sweep, $item.model) -ForegroundColor DarkYellow
            }
        }

        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered $filtered -rotatedRef ([ref]$rotatedCount) -keptRef ([ref]$keptCount)
    }

    Write-Progress -Activity "calibr bench" -Completed

    # Final summary
    $duration = (Get-Date) - $startTime
    $durStr = "{0}m{1:D2}s" -f ([int]$duration.TotalMinutes), ([int]($duration.TotalSeconds % 60))
    $bar = ("=" * 63)
    # Resolve the runs-per-config so the summary line can clarify that the
    # ok/fail counts are CONFIG-level - with runs_per_config > 1 each ok
    # config is N actual llama-server invocations, which surprised at
    # least one user (1 ok config ? 3 runs looked like only 3 things happened).
    $rppc = if ($Runs -gt 0) { $Runs }
            elseif ($null -ne $cfg.bench.runs_per_config) { [int]$cfg.bench.runs_per_config }
            else { 3 }
    $runsHint = if ($rppc -gt 1) { " configs ({0} runs each)" -f $rppc } else { " configs" }
    $okPct = if ($total -gt 0) { [math]::Round(($okCount / [double]$total) * 100, 0) } else { 0 }
    Write-Host ""
    Write-Host $bar -ForegroundColor Cyan
    Write-Host (" calibr - bench completed in $durStr") -ForegroundColor Cyan
    Write-Host ("   configs: {0} ok ({1}%) - {2} fail - {3} skipped / {4}{5}" -f $okCount, $okPct, $failCount, $skipCount, $total, $runsHint)
    if ($abandoned.Count -gt 0) {
        Write-Host ("   abandoned families: {0}" -f (($abandoned.Keys) -join ', ')) -ForegroundColor DarkYellow
        $reasons = @($abandoned.Values | Sort-Object -Unique)
        Write-Host ("   reason: {0}" -f ($reasons -join '; ')) -ForegroundColor DarkYellow
    }
    if ($rotatedCount -gt 0 -or $keptCount -gt 0) {
        Write-Host ("   files: {0} downloaded and deleted - {1} kept" -f $rotatedCount, $keptCount) -ForegroundColor DarkCyan
    }
    Write-Host $bar -ForegroundColor Cyan
}


