# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Get-Median" {
    It "returns the single value for N = 1" {
        Assert-Equal 42 (Get-Median -values @(42))
    }
    It "returns the middle element for odd N" {
        # Sorted: 7, 10, 12 -> middle = 10
        Assert-Equal 10 (Get-Median -values @(12, 7, 10))
    }
    It "returns the lower of two middles for even N (no averaging)" {
        # Sorted: 1, 2, 3, 4 -> lower middle = 2 (not 2.5)
        Assert-Equal 2 (Get-Median -values @(3, 1, 4, 2))
    }
    It "returns null for empty input" {
        Assert-Equal $null (Get-Median -values @())
    }
    It "returns null for null input" {
        Assert-Equal $null (Get-Median -values $null)
    }
    It "filters nulls and computes median over the remainder" {
        # After filtering nulls: 5, 10, 15 -> middle = 10
        Assert-Equal 10 (Get-Median -values @(5, $null, 15, $null, 10))
    }
    It "returns null when every value is null" {
        Assert-Equal $null (Get-Median -values @($null, $null, $null))
    }
    It "handles float values" {
        # Sorted: 1.1, 2.2, 3.3 -> middle = 2.2
        Assert-Equal 2.2 (Get-Median -values @(3.3, 1.1, 2.2))
    }
}

Describe "Resolve-TsBenchRunnerScript" {
    It "finds the local cli/dist runner for standalone repo runs" {
        $oldRoot = $script:CALIBR_ROOT
        $oldFlag = $env:CALIBR_TS_BENCH
        $oldScript = $env:CALIBR_TS_BENCH_SCRIPT
        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "calibr-ts-runner-test-$([Guid]::NewGuid().ToString('N'))"
        $runner = Join-Path $tmpRoot "cli\dist\benchRunnerCli.js"
        New-Item -ItemType Directory -Path (Split-Path $runner -Parent) -Force | Out-Null
        Set-Content -LiteralPath $runner -Value "stub" -Encoding UTF8
        try {
            $script:CALIBR_ROOT = $tmpRoot
            $env:CALIBR_TS_BENCH = $null
            $env:CALIBR_TS_BENCH_SCRIPT = $null
            Assert-Equal $runner (Resolve-TsBenchRunnerScript)
        } finally {
            $script:CALIBR_ROOT = $oldRoot
            $env:CALIBR_TS_BENCH = $oldFlag
            $env:CALIBR_TS_BENCH_SCRIPT = $oldScript
            Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "honors CALIBR_TS_BENCH=0 as an opt-out" {
        $oldFlag = $env:CALIBR_TS_BENCH
        try {
            $env:CALIBR_TS_BENCH = "0"
            Assert-Equal "" (Resolve-TsBenchRunnerScript)
        } finally {
            $env:CALIBR_TS_BENCH = $oldFlag
        }
    }
}

Describe "Resolve-TsResultCoreScript" {
    It "finds the local cli/dist result-core runner for standalone repo runs" {
        $oldRoot = $script:CALIBR_ROOT
        $oldFlag = $env:CALIBR_TS_RESULT_CORE
        $oldScript = $env:CALIBR_TS_RESULT_CORE_SCRIPT
        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "calibr-ts-result-core-test-$([Guid]::NewGuid().ToString('N'))"
        $runner = Join-Path $tmpRoot "cli\dist\resultCoreCli.js"
        New-Item -ItemType Directory -Path (Split-Path $runner -Parent) -Force | Out-Null
        Set-Content -LiteralPath $runner -Value "stub" -Encoding UTF8
        try {
            $script:CALIBR_ROOT = $tmpRoot
            $env:CALIBR_TS_RESULT_CORE = $null
            $env:CALIBR_TS_RESULT_CORE_SCRIPT = $null
            Assert-Equal $runner (Resolve-TsResultCoreScript)
        } finally {
            $script:CALIBR_ROOT = $oldRoot
            $env:CALIBR_TS_RESULT_CORE = $oldFlag
            $env:CALIBR_TS_RESULT_CORE_SCRIPT = $oldScript
            Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "honors CALIBR_TS_RESULT_CORE=0 as an opt-out" {
        $oldFlag = $env:CALIBR_TS_RESULT_CORE
        try {
            $env:CALIBR_TS_RESULT_CORE = "0"
            Assert-Equal "" (Resolve-TsResultCoreScript)
        } finally {
            $env:CALIBR_TS_RESULT_CORE = $oldFlag
        }
    }
}

Describe "TypeScript server lifecycle" {
    $benchSource = Get-Content (Join-Path $PSScriptRoot "..\..\engine\bench.ps1") -Raw

    It "finds the local lifecycle runner and honors the opt-out" {
        $oldRoot = $script:CALIBR_ROOT
        $oldFlag = $env:CALIBR_TS_LIFECYCLE
        $oldScript = $env:CALIBR_TS_LIFECYCLE_SCRIPT
        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "calibr-ts-lifecycle-test-$([Guid]::NewGuid().ToString('N'))"
        $runner = Join-Path $tmpRoot "cli\dist\serverLifecycleCli.js"
        New-Item -ItemType Directory -Path (Split-Path $runner -Parent) -Force | Out-Null
        Set-Content -LiteralPath $runner -Value "stub" -Encoding UTF8
        try {
            $script:CALIBR_ROOT = $tmpRoot
            $env:CALIBR_TS_LIFECYCLE = $null
            $env:CALIBR_TS_LIFECYCLE_SCRIPT = $null
            Assert-Equal $runner (Resolve-TsServerLifecycleScript)
            $env:CALIBR_TS_LIFECYCLE = "0"
            Assert-Equal "" (Resolve-TsServerLifecycleScript)
        } finally {
            $script:CALIBR_ROOT = $oldRoot
            $env:CALIBR_TS_LIFECYCLE = $oldFlag
            $env:CALIBR_TS_LIFECYCLE_SCRIPT = $oldScript
            Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "owns server start/readiness/stop while preserving the PowerShell fallback" {
        Assert-True ($benchSource -match 'function Start-TsServerLifecycle') "TS lifecycle launcher missing"
        Assert-True ($benchSource -match 'function Stop-TsServerLifecycle') "TS lifecycle stop missing"
        Assert-True ($benchSource -match 'serverLifecycleCli\.js') "lifecycle entrypoint should be wired"
        Assert-True ($benchSource -match '\$serverPid = \[int\]\$lifecycle\.server_pid') "real llama-server PID should be used"
        Assert-True ($benchSource -match 'Get-TsServerLifecycleStatus') "PowerShell adapter should consume lifecycle status"
        Assert-True ($benchSource -match '\$psi = New-Object System\.Diagnostics\.ProcessStartInfo') "direct PowerShell spawn fallback should remain"
        Assert-True ($benchSource -match 'CALIBR_TS_LIFECYCLE') "lifecycle opt-out should remain available"
    }
}

Describe "Background bench polling" {
    $benchSource = Get-Content (Join-Path $PSScriptRoot "..\..\engine\bench.ps1") -Raw

    It "keeps the poller best-effort and wired around the synchronous bench POST" {
        Assert-True ($benchSource -match 'function Start-BenchMetricPoller') "Start-BenchMetricPoller missing"
        Assert-True ($benchSource -match 'function Stop-BenchMetricPoller') "Stop-BenchMetricPoller missing"
        Assert-True ($benchSource -match 'function Resolve-TsMetricsPollerScript') "TS metrics poller resolver missing"
        Assert-True ($benchSource -match 'function Start-TsBenchMetricPoller') "TS metrics poller launcher missing"
        Assert-True ($benchSource -match 'metricsPollerCli\.js') "TS metrics poller entrypoint should be wired"
        Assert-True ($benchSource -match '\$tsPoller = Start-TsBenchMetricPoller') "Start-BenchMetricPoller should try TS first"
        Assert-True ($benchSource -match '\$inferencePoller = if \(-not \$MinimalPolling\)') "poller should honor -MinimalPolling"
        Assert-True ($benchSource -match 'finally \{\s*\$pollSamples = @\(Stop-BenchMetricPoller') "poller should stop in a finally block"
        Assert-True ($benchSource -match '\$Poller\.process\.Kill\(\)') "Stop-BenchMetricPoller should terminate TS process pollers"
        Assert-True ($benchSource -match 'process_vram_mib') "process-attributed VRAM sample missing"
        Assert-True ($benchSource -match '\[int\]\$IntervalMs = 150') "POST poller should sample fast runs at 150 ms"
        Assert-True ($benchSource -match 'nvidia-smi 2>\$null') "process VRAM should fall back to parsing standard nvidia-smi output"
        Assert-True ($benchSource -match 'llama-server') "nvidia-smi fallback should only accept llama-server rows"
    }
}

Describe "New-AggregatedBenchResult" {
    # Minimal fixtures: planning item + config + N per-run hashtables.
    # The aggregator is pure, so we hand-roll exactly what Invoke-OneBenchRun
    # would produce on a synthetic context-sweep config.
    function _item {
        return @{
            id = "qwen3.5-9b-q4km__ctx16384_q8"
            label = "Qwen3.5-9B Q4_K_M @ ctx=16384 / kv=q8_0"
            model = "Qwen3.5-9B"; variant = "Q4_K_M"; series = "Qwen3.5"; sweep = "context"; level = "high"
            model_path = "C:\models\Qwen3.5-9B-Q4_K_M.gguf"
            mmproj_path = $null
            extra_args = "--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0"
        }
    }
    function _cfg {
        return @{
            hardware = @{ vram_total_mib = 8192 }
            wddm_detection = @{
                vram_saturation_threshold = 0.92
                shared_delta_confirm_mib  = 500
            }
        }
    }
    function _run([int]$i, [int]$vramPeak, [int]$sharedPeak, [double]$promptTps, [double]$evalTps) {
        return @{
            run_index       = $i
            timestamp       = "2026-05-16T10:00:0$i"
            vram_before_mib = 1200
            vram_peak_mib   = $vramPeak
            vram_baseline_mib = 1200
            vram_baseline_pct = 0.1465
            vram_total_peak_mib = $vramPeak
            vram_process_peak_mib = $vramPeak - 1200
            vram_external_peak_mib = 1200
            shared_peak_mib = $sharedPeak
            load_sec        = 6.5
            ready           = $true
            ok              = $true
            error           = $null
            prompt_n        = 80
            prompt_tps      = $promptTps
            eval_n          = 128
            eval_tps        = $evalTps
            cpu_model_mib   = 0
            cuda_model_mib  = 5200
            kv_cache_mib    = 1024
            compute_cuda_mib = 360
            compute_host_mib = 80
            layers_offloaded = "33/33"
            fit_status      = "success"
            # Extended metrics (defaults make the aggregator happy even
            # when a test doesn't care about these dimensions)
            ttft_sec             = 0.2
            prompt_ms            = 200.0
            ttfr_ms              = 120.0
            e2e_ttft_ms          = 180.0
            total_request_ms     = 3200.0
            latency_total_request_ms = 420.0
            gpu_power_peak_w     = 140.0
            gpu_temp_peak_c      = 65
            gpu_util_avg_pct     = 80
            ram_baseline_mib     = 12000
            ram_used_peak_mib    = 600
            disk_read_peak_mb_s  = 350.0
        }
    }

    It "takes the median of the varying metrics across N=3 runs" {
        $runs = @(
            (_run 0 7000 30  410.0  40.0),
            (_run 1 7200 50  430.0  42.0),   # median sample
            (_run 2 7100 40  420.0  41.0)
        )
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        # Sorted vram_peak: 7000, 7100, 7200 -> 7100
        Assert-Equal 7100  $r.vram_peak_mib
        # Sorted shared_peak: 30, 40, 50 -> 40
        Assert-Equal 40    $r.shared_peak_mib
        # Sorted prompt_tps: 410, 420, 430 -> 420
        Assert-Equal 420.0 $r.prompt_tps
        # Sorted eval_tps: 40, 41, 42 -> 41
        Assert-Equal 41.0  $r.eval_tps
    }
    It "preserves identity fields from `$item and deterministic fields from runs[0]" {
        $runs = @((_run 0 7000 30 410.0 40.0), (_run 1 7200 50 430.0 42.0), (_run 2 7100 40 420.0 41.0))
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal "qwen3.5-9b-q4km__ctx16384_q8" $r.id
        Assert-Equal "Qwen3.5-9B" $r.model
        Assert-Equal "context" $r.sweep
        Assert-Equal "high" $r.level
        Assert-Equal 80 $r.prompt_n          # runs[0]
        Assert-Equal 128 $r.eval_n           # runs[0]
        Assert-Equal "33/33" $r.layers_offloaded
        Assert-Equal "success" $r.fit_status
        Assert-Equal 5200 $r.cuda_model_mib  # buffer fields are deterministic
    }
    It "recomputes WDDM-derived flags from the median vram_peak and shared_peak" {
        # Median vram_peak = 7100; 7100/8192 = 0.867 -> below 0.92 threshold
        # Median shared_peak = 40 -> below 500 mib confirm threshold
        $runs = @((_run 0 7000 30 410.0 40.0), (_run 1 7200 50 430.0 42.0), (_run 2 7100 40 420.0 41.0))
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 0.867 $r.wddm_vram_saturation
        Assert-False $r.wddm_flag_high_vram
        Assert-False $r.wddm_flag_shared_pos
    }
    It "flags WDDM paging when the median shared_peak exceeds the confirm threshold" {
        # Median shared_peak = 800 > 500 -> wddm_flag_shared_pos true
        $runs = @((_run 0 7000 600 410.0 40.0), (_run 1 7200 800 430.0 42.0), (_run 2 7100 1000 420.0 41.0))
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 800 $r.shared_peak_mib
        Assert-True $r.wddm_flag_shared_pos
    }
    It "infers fit_status from WDDM spill when llama.cpp does not report fit lines" {
        $safe = _run 0 7000 40 410.0 40.0
        $safe.fit_status = "unknown"
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs @($safe)
        Assert-Equal "success" $r.fit_status

        $spill = _run 0 7000 800 410.0 40.0
        $spill.fit_status = "unknown"
        $r2 = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs @($spill)
        Assert-Equal "failed_but_running" $r2.fit_status
    }
    It "carries the full per-run array in `runs` for audit" {
        $runs = @((_run 0 7000 30 410.0 40.0), (_run 1 7200 50 430.0 42.0), (_run 2 7100 40 420.0 41.0))
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 3 $r.runs.Count
        Assert-Equal 7000 $r.runs[0].vram_peak_mib
        Assert-Equal 7200 $r.runs[1].vram_peak_mib
        Assert-Equal 7100 $r.runs[2].vram_peak_mib
    }
    It "derives first/repeat eval stats without dropping the first run" {
        $runs = @(
            (_run 0 7000 30 410.0 46.0),
            (_run 1 7200 50 430.0 64.0),
            (_run 2 7100 40 420.0 55.0)
        )
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 3    $r.run_count
        Assert-Equal 55.0 $r.eval_tps          # median still includes every run
        Assert-Equal 46.0 $r.first_eval_tps
        Assert-Equal 55.0 $r.repeat_eval_tps   # lower median of 55,64
        Assert-Equal 46.0 $r.eval_min_tps
        Assert-Equal 64.0 $r.eval_max_tps
        Assert-Equal 32.7 $r.eval_spread_pct
    }
    It "handles N=1 (median is the single value; runs array has length one)" {
        $runs = @((_run 0 5500 100 380.0 35.0))
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 5500  $r.vram_peak_mib
        Assert-Equal 100   $r.shared_peak_mib
        Assert-Equal 380.0 $r.prompt_tps
        Assert-Equal 35.0  $r.eval_tps
        Assert-Equal 1 $r.runs.Count
        Assert-Equal 1 $r.run_count
        Assert-Equal 35.0 $r.first_eval_tps
        Assert-Equal $null $r.repeat_eval_tps
        Assert-Equal 0.0 $r.eval_spread_pct
    }
    It "aggregates extended metrics (median for ttft/util, max for power/temp/ram/disk)" {
        # Hand-build runs with distinct values per dimension so the
        # aggregation rule (median vs max) is observable.
        $r1 = _run 0 7000 30 410.0 40.0
        $r1.ttft_sec            = 0.20
        $r1.prompt_ms           = 200.0
        $r1.ttfr_ms             = 100.0
        $r1.e2e_ttft_ms         = 180.0
        $r1.total_request_ms    = 3000.0
        $r1.latency_total_request_ms = 360.0
        $r1.gpu_util_avg_pct    = 60
        $r1.gpu_power_peak_w    = 130.0
        $r1.gpu_temp_peak_c     = 60
        $r1.ram_used_peak_mib   = 500
        $r1.disk_read_peak_mb_s = 200.0
        $r2 = _run 1 7200 50 430.0 42.0
        $r2.ttft_sec            = 0.30   # median
        $r2.prompt_ms           = 300.0  # median
        $r2.ttfr_ms             = 120.0  # median
        $r2.e2e_ttft_ms         = 240.0  # median
        $r2.total_request_ms    = 3200.0 # median
        $r2.latency_total_request_ms = 420.0 # median
        $r2.gpu_util_avg_pct    = 75      # median
        $r2.gpu_power_peak_w    = 180.0  # max
        $r2.gpu_temp_peak_c     = 72     # max
        $r2.ram_used_peak_mib   = 900    # max
        $r2.disk_read_peak_mb_s = 500.0  # max
        $r3 = _run 2 7100 40 420.0 41.0
        $r3.ttft_sec            = 0.40
        $r3.prompt_ms           = 400.0
        $r3.ttfr_ms             = 140.0
        $r3.e2e_ttft_ms         = 280.0
        $r3.total_request_ms    = 3400.0
        $r3.latency_total_request_ms = 460.0
        $r3.gpu_util_avg_pct    = 90
        $r3.gpu_power_peak_w    = 150.0
        $r3.gpu_temp_peak_c     = 65
        $r3.ram_used_peak_mib   = 700
        $r3.disk_read_peak_mb_s = 300.0
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs @($r1, $r2, $r3)
        Assert-Equal 0.3   $r.ttft_sec               "ttft median"
        Assert-Equal 300.0 $r.prompt_ms              "prompt ms median"
        Assert-Equal 120.0 $r.ttfr_ms                "ttfr median"
        Assert-Equal 240.0 $r.e2e_ttft_ms            "e2e ttft median"
        Assert-Equal 3200.0 $r.total_request_ms      "request ms median"
        Assert-Equal 420.0 $r.latency_total_request_ms "latency request ms median"
        Assert-Equal 75    $r.gpu_util_avg_pct        "util median"
        Assert-Equal 180.0 $r.gpu_power_peak_w        "power max"
        Assert-Equal 72    $r.gpu_temp_peak_c         "temp max"
        Assert-Equal 900   $r.ram_used_peak_mib       "ram max"
        Assert-Equal 500.0 $r.disk_read_peak_mb_s     "disk max"
    }
    It "aggregates VRAM baseline and process-attribution fields" {
        $runs = @(
            (_run 0 7000 30 410.0 40.0),
            (_run 1 7200 50 430.0 42.0),
            (_run 2 7100 40 420.0 41.0)
        )
        $r = New-AggregatedBenchResult -item (_item) -cfg (_cfg) -runs $runs
        Assert-Equal 1200   $r.vram_baseline_mib      "baseline MiB"
        Assert-Equal 0.1465 $r.vram_baseline_pct      "baseline pct"
        Assert-Equal 7100   $r.vram_total_peak_mib    "total peak median"
        Assert-Equal 5900   $r.vram_process_peak_mib  "process peak median"
        Assert-Equal 1200   $r.vram_external_peak_mib "external peak median"
    }
}


Describe "Get-FailureReason" {
    It "returns \$null when the result succeeded" {
        $r = Get-FailureReason -result @{ ok = $true }
        Assert-Equal $null $r
    }
    It "returns 'unsupported_arch' when llama.cpp didn't recognize the model" {
        $r = Get-FailureReason -result @{ ok = $false; unsupported_architecture = "qwen-new"; shared_peak_mib = 0; ready = $false }
        Assert-Equal "unsupported_arch" $r
    }
    It "returns 'vram_overflow' when fit_status flagged failed_but_running" {
        $r = Get-FailureReason -result @{ ok = $false; fit_status = "failed_but_running"; shared_peak_mib = 12000; ready = $false; unsupported_architecture = $null }
        Assert-Equal "vram_overflow" $r
    }
    It "returns 'vram_overflow' on high shared_peak even without fit flag (defensive)" {
        $r = Get-FailureReason -result @{ ok = $false; fit_status = "unknown"; shared_peak_mib = 900; ready = $false; unsupported_architecture = $null } -sharedConfirmMib 500
        Assert-Equal "vram_overflow" $r
    }
    It "returns 'server_timeout' when ready was false with low shared_peak" {
        $r = Get-FailureReason -result @{ ok = $false; fit_status = "success"; shared_peak_mib = 50; ready = $false; unsupported_architecture = $null } -sharedConfirmMib 500
        Assert-Equal "server_timeout" $r
    }
    It "returns 'other' as the catch-all when ok is false but no signal fired" {
        $r = Get-FailureReason -result @{ ok = $false; fit_status = "success"; shared_peak_mib = 50; ready = $true; unsupported_architecture = $null } -sharedConfirmMib 500
        Assert-Equal "other" $r
    }
}

Describe "Select-PlanForBench" {
    It "returns empty when the plan is empty" {
        $r = Select-PlanForBench -plan @()
        Assert-Equal 0 $r.Count
    }
    It "returns the single matching entry when no filters are set" {
        $plan = @(@{ model = "Qwen3.5-9B"; level = "high"; id = "T001" })
        $r = Select-PlanForBench -plan $plan
        Assert-Equal 1 $r.Count
        Assert-Equal "Qwen3.5-9B" $r[0].model
    }
    It "applies ModelFilter as a regex match" {
        $plan = @(
            @{ model = "Qwen3.5-9B"; level = "high" }
            @{ model = "Gemma-4-E2B"; level = "low" }
        )
        $r = Select-PlanForBench -plan $plan -ModelFilter "Qwen"
        Assert-Equal 1 $r.Count
        Assert-Equal "Qwen3.5-9B" $r[0].model
    }
    It "applies LevelFilter on the model's hardware level" {
        $plan = @(
            @{ model = "Qwen3.5-9B"; level = "high" }
            @{ model = "Gemma-4-E2B"; level = "low" }
        )
        $r = Select-PlanForBench -plan $plan -LevelFilter "low"
        Assert-Equal 1 $r.Count
        Assert-Equal "Gemma-4-E2B" $r[0].model
    }
    It "drops phantom \$null entries from the input (regression: empty-plan ContainsKey crash)" {
        # When $plan is empty in PowerShell, `$plan | Where-Object` actually
        # pipes one $null item through; @() then wraps it to a 1-element
        # array, which downstream then crashed Invoke-Bench's rotation
        # context build with `ContainsKey($null)`. The leading `$_ -and`
        # in Select-PlanForBench filters those nulls back out.
        $r = Select-PlanForBench -plan @($null)
        Assert-Equal 0 $r.Count
    }
}


Describe "Invoke-RotationCheck" {
    # Each It manipulates script vars matching CLI-level cleanup flags and
    # $script:CALIBR_DOWNLOADS (so the manifest lookup hits a per-test temp
    # file). Saved here, restored after.
    $script:_origKeep      = $script:KeepDownloads
    $script:_origRetention = $script:DownloadRetention
    $script:_origDlPath    = $script:CALIBR_DOWNLOADS

    function _modelStatus {
        param([int]$needed, [int]$ok, [int]$fail = 0, [int]$skip = 0, [string]$mmproj = "")
        $done = $ok + $fail + $skip
        $mp = if ($mmproj) { $mmproj } else { $null }
        return @{
            needed     = $needed
            ok         = $ok
            fail       = $fail
            skip       = $skip
            done       = $done
            modelName  = "TestModel"
            mmprojPath = $mp
            rotated    = $false
        }
    }
    function _item {
        param([string]$path, [string]$mmproj = "")
        return @{
            model_path  = $path
            mmproj_path = if ($mmproj) { $mmproj } else { $null }
            model       = "TestModel"
            label       = "test"
        }
    }
    function _newTempGguf {
        param([string]$base = "test")
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-rot-test-{0}-{1}.gguf" -f $base, ([guid]::NewGuid()))
        Set-Content -LiteralPath $tmp -Value "binary" -NoNewline
        return $tmp
    }
    function _useFreshManifest {
        param([string[]]$tracked = @())
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-rot-manifest-{0}.json" -f ([guid]::NewGuid()))
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        $script:CALIBR_DOWNLOADS = $tmp
        $script:DownloadRetention = "cleanup"
        foreach ($p in $tracked) {
            Add-DownloadManifestEntry -CatalogId "s" -Model "M" -ModelPath $p
        }
        return $tmp
    }

    It "is a no-op when the item's model_path is not in modelStatus" {
        $script:KeepDownloads = $false
        $tmp = _useFreshManifest @()
        $item = _item "C:\not-tracked.gguf"
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus @{} -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 0 $r
        Assert-Equal 0 $k
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "is a no-op when done < needed (more configs still to run)" {
        $script:KeepDownloads = $false
        $tmp = _useFreshManifest @()
        $mp = "C:\partial.gguf"
        $modelStatus = @{ $mp = (_modelStatus -needed 3 -ok 1) }
        $item = _item $mp
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 0 $r
        Assert-Equal 0 $k
        Assert-False $modelStatus[$mp].rotated
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "is idempotent on a second call (rotated flag already set)" {
        $script:KeepDownloads = $true   # quickest path to setting rotated=true without deleting a real file
        $tmp = _useFreshManifest @()
        $mp = "C:\idem.gguf"
        $modelStatus = @{ $mp = (_modelStatus -needed 2 -ok 2) }
        $item = _item $mp
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $k
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $k  "second call must not increment kept again"
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "keeps the file when -KeepDownloads is set, even with a clean run" {
        $script:KeepDownloads = $true
        $gguf = _newTempGguf "keep-flag"
        $tmp = _useFreshManifest @($gguf)
        $modelStatus = @{ $gguf = (_modelStatus -needed 1 -ok 1) }
        $item = _item $gguf
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 0 $r
        Assert-Equal 1 $k
        Assert-True (Test-Path $gguf)
        if (Test-Path $gguf) { Remove-Item $gguf -Force }
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "maps -KeepDownloads to keep-all but otherwise honors DownloadRetention" {
        $script:KeepDownloads = $false
        $script:DownloadRetention = "keep-top-3"
        Assert-Equal "keep-top-3" (Get-DownloadRetentionPolicy)

        $script:KeepDownloads = $true
        $script:DownloadRetention = "cleanup"
        Assert-Equal "keep-all" (Get-DownloadRetentionPolicy)
    }

    It "keeps the file when it is not in the manifest (user-owned)" {
        $script:KeepDownloads = $false
        $gguf = _newTempGguf "user-owned"
        $tmp = _useFreshManifest @()   # nothing tracked
        $modelStatus = @{ $gguf = (_modelStatus -needed 1 -ok 1) }
        $item = _item $gguf
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 0 $r
        Assert-Equal 1 $k
        Assert-True (Test-Path $gguf)
        if (Test-Path $gguf) { Remove-Item $gguf -Force }
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "deletes the file even when some configs failed (simple-rotation policy)" {
        # Per the simple-rotation policy: bench has finished for this model
        # (done == needed), the file is calibr-downloaded, KeepDownloads is
        # off -> delete. Failure is irrelevant: the per-config result JSONs
        # are persisted separately and are the actual debug evidence; the
        # .gguf itself has no diagnostic value beyond the bench. Keeping it
        # would waste disk for a file that's never going to be benched again
        # without an explicit user action.
        $script:KeepDownloads = $false
        $gguf = _newTempGguf "had-failure"
        $tmp = _useFreshManifest @($gguf)
        $modelStatus = @{ $gguf = (_modelStatus -needed 3 -ok 2 -fail 1) }
        $item = _item $gguf
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $r
        Assert-Equal 0 $k
        Assert-False (Test-Path $gguf)  "rotation must clean up regardless of fail count"
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "deletes the file even when configs were skipped via abandonment" {
        # Same policy: the model abandonment path (unsupported_arch, or the
        # sweep-aware vram_overflow abandon) leaves skip > 0 on the modelStatus.
        # We still delete: keeping the file 'just in case the user updates
        # llama.cpp / buys more VRAM' would accumulate dead files forever.
        # If the user wants to bench it again, they can re-fetch in seconds.
        $script:KeepDownloads = $false
        $gguf = _newTempGguf "had-skip"
        $tmp = _useFreshManifest @($gguf)
        $modelStatus = @{ $gguf = (_modelStatus -needed 3 -ok 1 -skip 2) }
        $item = _item $gguf
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $r
        Assert-Equal 0 $k
        Assert-False (Test-Path $gguf)
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "deletes the .gguf when everything is clean and the file is calibr-managed" {
        $script:KeepDownloads = $false
        $gguf = _newTempGguf "clean-delete"
        $tmp = _useFreshManifest @($gguf)
        $modelStatus = @{ $gguf = (_modelStatus -needed 1 -ok 1) }
        $item = _item $gguf
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $r
        Assert-Equal 0 $k
        Assert-False (Test-Path $gguf)  "clean rotation should have removed the .gguf"
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "deletes mmproj alongside .gguf when no other model in filtered references it" {
        $script:KeepDownloads = $false
        $gguf   = _newTempGguf "with-mmproj-gguf"
        $mmproj = _newTempGguf "with-mmproj-mmproj"
        $tmp = _useFreshManifest @($gguf)
        $modelStatus = @{ $gguf = (_modelStatus -needed 1 -ok 1 -mmproj $mmproj) }
        $item = _item $gguf $mmproj
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $r
        Assert-False (Test-Path $gguf)
        Assert-False (Test-Path $mmproj)
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "preserves mmproj when another not-yet-rotated model in filtered shares it" {
        $script:KeepDownloads = $false
        $gguf    = _newTempGguf "shared-a"
        $sibling = _newTempGguf "shared-b"
        $mmproj  = _newTempGguf "shared-mmproj"
        $tmp = _useFreshManifest @($gguf, $sibling)
        $modelStatus = @{
            $gguf    = (_modelStatus -needed 1 -ok 1 -mmproj $mmproj)
            $sibling = @{ needed=2; ok=1; fail=0; skip=0; done=1; modelName="Sibling"; mmprojPath=$mmproj; rotated=$false }
        }
        $item        = _item $gguf    $mmproj
        $siblingItem = _item $sibling $mmproj
        $r = 0; $k = 0
        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered @($item, $siblingItem) -rotatedRef ([ref]$r) -keptRef ([ref]$k)
        Assert-Equal 1 $r
        Assert-False (Test-Path $gguf)   "first model's .gguf should be deleted"
        Assert-True  (Test-Path $mmproj) "shared mmproj must survive while sibling still needs it"
        if (Test-Path $sibling) { Remove-Item $sibling -Force }
        if (Test-Path $mmproj)  { Remove-Item $mmproj  -Force }
        if (Test-Path $tmp)     { Remove-Item $tmp     -Force }
    }

    $script:KeepDownloads      = $script:_origKeep
    $script:DownloadRetention  = $script:_origRetention
    $script:CALIBR_DOWNLOADS   = $script:_origDlPath
}

Describe "Invoke-OneBench model-file pre-flight" {
    function _missingItem {
        return @{
            id = "preflight_missing_test"
            label = "Preflight Missing @ test"
            model = "PreflightModel"; variant = "Q4_K_M"; series = "Preflight"; sweep = "offload"; level = "ultra"
            model_path = (Join-Path ([System.IO.Path]::GetTempPath()) "calibr-does-not-exist-xyz.gguf")
            mmproj_path = $null
            extra_args = "--ctx-size 2048 --gpu-layers 99"
        }
    }
    function _cfg2 {
        return @{
            llama_server_exe = "llama-server"
            hardware = @{ vram_total_mib = 8192 }
            wddm_detection = @{ vram_saturation_threshold = 0.92; shared_delta_confirm_mib = 500 }
            bench = @{ runs_per_config = 1 }
        }
    }

    It "fails fast with failure_reason 'model_missing' when the .gguf is absent" {
        $item = _missingItem
        $jsonFile = Join-Path $CALIBR_RESULTS_DIR "$($item.id).json"
        if (Test-Path $jsonFile) { Remove-Item -LiteralPath $jsonFile -Force }
        $r = Invoke-OneBench -item $item -cfg (_cfg2)
        Assert-False $r.ok "should not be ok"
        Assert-Equal 'model_missing' $r.failure_reason
        Assert-False $r.ready "should report not-ready"
    }

    It "does not persist a results JSON for a missing model (so re-download retries)" {
        $item = _missingItem
        $jsonFile = Join-Path $CALIBR_RESULTS_DIR "$($item.id).json"
        Set-Content -LiteralPath $jsonFile -Value '{"stale":true}' -Encoding utf8   # pretend a stale result exists
        Invoke-OneBench -item $item -cfg (_cfg2) | Out-Null
        Assert-False (Test-Path $jsonFile) "stale results JSON should have been removed"
    }
}

Exit-WithResults

