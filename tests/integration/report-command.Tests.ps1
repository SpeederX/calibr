# Smoke tests for the report template + Invoke-Report integration. Static
# checks against report.template.html catch most regressions cheaply; the
# data-derivation logic is unit-tested in tests/unit/report.Tests.ps1.
. "$PSScriptRoot\..\harness.ps1"

$labRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$tplPath = Join-Path $labRoot "report.template.html"

Describe "report.template.html structure (v1.2 redesign)" {
    $tpl = Get-Content $tplPath -Raw

    It "exists and is non-empty" {
        Assert-True ($tpl.Length -gt 1000) "template should have meaningful content"
    }
    It "exposes the four placeholders Invoke-Report fills" {
        Assert-True ($tpl -match '%%DATA%%')     "missing %%DATA%% placeholder"
        Assert-True ($tpl -match '%%WINNERS%%')  "missing %%WINNERS%% placeholder"
        Assert-True ($tpl -match '%%CFG%%')      "missing %%CFG%% placeholder"
        Assert-True ($tpl -match '%%NOW%%')      "missing %%NOW%% placeholder"
    }
    It "embeds the scatter section (kept from v1.1)" {
        Assert-True ($tpl -match 'id="scatter"')           "scatter SVG element missing"
        Assert-True ($tpl -match 'function renderScatter') "renderScatter function missing"
        Assert-True ($tpl -match 'function modelColor')    "modelColor function missing"
        Assert-True ($tpl -match 'class="scatter-line-gpu"') "scatter-line-gpu CSS class missing"
        Assert-True ($tpl -match 'GPU VRAM \(')            "scatter chart should label the GPU VRAM reference line"
    }
    It "uses log-10 scale on the scatter X axis" {
        Assert-True ($tpl -match 'Math\.log10') "log-10 transform missing from renderScatter"
        Assert-True ($tpl -match 'log-10')      "X axis label should mention log-10 scale"
    }
    It "puts the scatter chart before the models list (Phase F: memory-vs-latency first)" {
        $scatterIdx = $tpl.IndexOf('id="scatter"')
        $modelsIdx  = $tpl.IndexOf('id="models-list"')
        Assert-True ($scatterIdx -gt 0) "scatter not found"
        Assert-True ($modelsIdx  -gt 0) "models list not found"
        Assert-True ($scatterIdx -lt $modelsIdx) "scatter should appear before models list in document order"
    }
    It "exposes the filter selector with the four scoring profiles" {
        Assert-True ($tpl -match 'class="filter-bar"')         "filter bar container missing"
        Assert-True ($tpl -match 'data-filter="speed"')        "speed filter button missing"
        Assert-True ($tpl -match 'data-filter="efficiency"')   "efficiency filter button missing"
        Assert-True ($tpl -match 'data-filter="safety"')       "safety-balanced filter button missing"
        Assert-True ($tpl -match 'data-filter="overall"')      "overall filter button missing"
        Assert-True ($tpl -match 'const SCORERS = ')           "SCORERS registry missing"
        Assert-True ($tpl -match 'function computeWinners')    "computeWinners function missing"
    }
    It "renders the models list as collapsible details/summary rows" {
        Assert-True ($tpl -match 'id="models-list"')                 "models-list container missing"
        Assert-True ($tpl -match 'details\.model-row')               "model-row CSS missing"
        Assert-True ($tpl -match 'function renderModelsList')        "renderModelsList function missing"
        # Class string may now have additional modifiers (e.g. ' is-failed') appended.
        Assert-True ($tpl -match 'details class="model-row')         "details element for model row missing"
    }
    It "explains adaptive planning without adding another wide results column" {
        Assert-True ($tpl -match 'function calibrationSummary')       "calibration summary helper missing"
        Assert-True ($tpl -match 'verified fit')                      "verified fit text missing"
        Assert-True ($tpl -match 'calibration_cache_hit')             "cache source detail missing"
        Assert-True ($tpl -match 'adaptive MoE')                       "adaptive MoE summary missing"
        Assert-True ($tpl -match 'function workloadTitle')            "diagnostic workload tooltip missing"
    }
    It "surfaces failure_reason for failed configs and 'no winner' models" {
        Assert-True ($tpl -match 'function fitLabel')                "fitLabel helper missing"
        Assert-True ($tpl -match 'function failureLabel')            "failureLabel helper missing"
        Assert-True ($tpl -match 'function noWinnerSummary')         "noWinnerSummary helper missing"
        Assert-True ($tpl -match 'unsupported_architecture')         "structured unsupported architecture case missing from fitLabel"
        Assert-True ($tpl -match 'request_timeout')                  "structured request timeout case missing from fitLabel"
        Assert-True ($tpl -match 'unsupported_architecture')         "unsupported_architecture detail missing"
        Assert-True ($tpl -match 'is-failed')                        "is-failed model row modifier missing"
    }
    It "exposes the eval/vram tabbed widget that replaces the old separate bar sections" {
        Assert-True ($tpl -match 'id="bars-tabs"')           "bars-tabs container missing"
        Assert-True ($tpl -match 'data-bars="eval"')         "eval bars tab missing"
        Assert-True ($tpl -match 'data-bars="vram"')         "vram bars tab missing"
        Assert-True ($tpl -match 'function renderBars')      "renderBars function missing"
        Assert-True ($tpl -match 'function vramHeadroom')    "vramHeadroom annotation function missing"
        Assert-True ($tpl -match '\.bar-row-ann')            "bar-row-ann CSS class missing"
    }
    It "supports client-side .bat generation for any config" {
        Assert-True ($tpl -match 'function generateBatText')  "generateBatText function missing"
        Assert-True ($tpl -match 'function downloadBat')      "downloadBat function missing"
        Assert-True ($tpl -match 'data-cfg-id=')              "config-id data attribute missing on bat links"
    }

    It "keeps diagnostic workload results out of launcher winner selection" {
        $source = Get-Content (Join-Path $labRoot "engine\report.ps1") -Raw
        Assert-True ($source -match "workload_kind.*baseline") "PowerShell winner filter must require baseline workloads"
        Assert-True ($tpl -match "isWinnerEligible") "browser winner policy must exclude diagnostic workloads"
    }
    It "shows vanilla llama.cpp controls without treating them as winners or launchers" {
        $source = Get-Content (Join-Path $labRoot "engine\report.ps1") -Raw
        Assert-True ($source -match "not.*control_kind") "PowerShell winner filter must exclude controls"
        Assert-True ($tpl -match "function vanillaClaim") "vanilla uplift helper missing"
        Assert-True ($tpl -match "calibr made it usable") "loadability claim missing"
        Assert-True ($tpl -match "vanilla control") "control row label missing"
        Assert-True ($tpl -match "!c\.control_kind") "controls must not expose launcher downloads"
    }
    It "marks winners visually in scatter, bars, and tables" {
        Assert-True ($tpl -match 'is-winner')                 "is-winner CSS class missing"
        Assert-True ($tpl -match 'scatter-dot\.is-winner')    "scatter winner styling missing"
        Assert-True ($tpl -match 'bar-row\.is-winner')        "bars winner styling missing"
    }
    It "uses readable memory-risk badges in metric bars" {
        Assert-False ($tpl -match 'WDDM\?')                   "ambiguous WDDM? badge should not be rendered"
        Assert-True  ($tpl.Contains("[WDDM +"))               "confirmed WDDM shared-memory badge missing"
        Assert-True  ($tpl.Contains("[VRAM "))                "high-VRAM saturation badge missing"
    }
    It "explains VRAM cliff and WDDM spill near the memory bars" {
        Assert-True ($tpl -match 'VRAM and WDDM explanation') "memory tooltip affordance missing"
        Assert-True ($tpl -match 'Fully in VRAM')             "fully-in-VRAM case missing"
        Assert-True ($tpl -match 'Near the cliff')            "near-cliff case missing"
        Assert-True ($tpl -match 'Spill / paging')            "spill case missing"
        Assert-True ($tpl -match 'MoE note')                  "MoE memory note missing"
    }
    It "adds explainers to All results headers" {
        Assert-True ($tpl -match 'class="th-help"')       "header help affordance missing"
        Assert-True ($tpl -match 'Client time to the first SSE frame') "stream-open header tooltip missing"
        Assert-True ($tpl -match 'prompt processing / prefill time')      "Prompt ms tooltip missing"
        Assert-True ($tpl -match 'Decode throughput')     "Eval t/s tooltip missing"
        Assert-True ($tpl -match 'Prompt rel %')          "Prompt relative-percent header missing"
        Assert-True ($tpl -match 'Eval rel %')            "Eval relative-percent header missing"
        Assert-True ($tpl -match 'normalized within the currently visible rows') "relative-percent tooltip missing"
        Assert-True ($tpl -match 'WDDM shared-memory growth') "Shared tooltip missing"
        Assert-True ($tpl -match 'one-time process start, model read, and backend initialization') "model-level cold-load explanation missing"
        Assert-True ($tpl -match 'Metric glossary') "metric glossary missing"
        Assert-True ($tpl -match 'Readable formula') "metric glossary formula column missing"
        Assert-True ($tpl -match 'Why it is useful') "metric glossary usefulness column missing"
        Assert-True ($tpl -match 'Average total CPU utilization') "CPU metric explanation missing"
        Assert-True ($tpl -match 'system-level NVIDIA reading') "VRAM tooltip should explain system-level scope"
        Assert-True ($tpl -match 'Estimated run delta') "VRAM tooltip should show baseline-subtracted estimate"
        Assert-True ($tpl -match 'function benchmarkVramUsedMib') "memory charts should subtract system baseline"
        Assert-True ($tpl -match 'baseline % = VRAM used before run / total VRAM') "baseline formula should be documented"
        Assert-True ($tpl -match '1500 / 8192 = 18\.3%') "baseline example should be documented"
        Assert-True ($tpl -match 'apps, 3D processes, browsers, overlays') "VRAM explainer should warn about external activity"
        Assert-True ($tpl -match 'baselineWarningPct') "VRAM tooltip should use configurable baseline warning threshold"
        Assert-True ($tpl -match 'Baseline warning') "VRAM tooltip should warn on high baseline usage"
        Assert-True ($tpl -match 'scatter-baseline-toggle') "scatter baseline toggle missing"
        Assert-True ($tpl -match 'system_ram_total_mib') "scatter should use total installed system RAM"
        Assert-True ($tpl -match '&lt;llama_server_path&gt;') "llama-server path should be redacted for display"
        Assert-True ($tpl -match 'effectiveMemoryUsedMib\(d, STATE\.adjustScatterBaseline\)') "scatter should use effective-memory semantics"
        Assert-True ($tpl -match 'withRam <= cap \? vram : withRam') "RAM should only be added after VRAM capacity is exceeded"
        Assert-True ($tpl -match 'function confirmedSharedMib') "shared-memory display should use the confirmation threshold"
        Assert-True ($tpl -match 'id="timeline"') "run timeline chart missing"
        Assert-True ($tpl -match 'function renderTimeline') "run timeline renderer missing"
        Assert-True ($tpl -match 'data-config-id') "scatter points should open the linked timeline"
        Assert-True ($tpl -match 'show all runs') "timeline should support an all-runs overlay"
        Assert-True ($tpl -match 'latency_prompt.*latency_eval') "timeline should focus its domain on latency phases"
        Assert-False ($tpl -match 'timeline-shared') "timeline should not render shared memory"
        Assert-True ($tpl -match 'timeline-legend') "timeline color legend missing"
        Assert-True ($tpl -match 'VRAM run') "report should label baseline-adjusted VRAM explicitly"
        Assert-True ($tpl -match 'unknown \(legacy record\)') "invalid historical llama build tags should be identified as legacy"
    }
    It "falls back to requested gpu layers when llama.cpp does not report actual layers" {
        Assert-True ($tpl -match 'function layersLabel')       "layersLabel helper missing"
        Assert-True ($tpl -match 'req '' \+ m\[1\]')           "requested gpu-layers fallback missing"
        Assert-True ($tpl -match 'requested --gpu-layers')     "layers tooltip should explain requested fallback"
    }
    It "reports cold load and disk once per model instead of per config" {
        Assert-True ($tpl -match 'function coldLoadSummary') "model cold-load summary missing"
        Assert-True ($tpl -match 'model_cold_load_ms') "model cold-load metric missing"
        Assert-True ($tpl -match 'model_cold_disk_read_peak_mb_s') "model cold-disk metric missing"
        Assert-False ($tpl -match 'data-bars="disk"') "per-config disk tab should be removed"
    }
    It "surfaces eval run stability in the Eval tokens/s tab" {
        Assert-True ($tpl -match 'function evalRunNote')         "eval run note helper missing"
        Assert-True ($tpl -match 'first_eval_tps')               "first eval metric missing"
        Assert-True ($tpl -match 'eval_spread_pct')              "eval spread metric missing"
    }
    It "renders normalized throughput percentages with zero-division guard" {
        Assert-True ($tpl -match 'function normalizedPct') "normalizedPct helper missing"
        Assert-True ($tpl -match 'extent\.max <= extent\.min\) return 100') "normalizedPct should guard max == min"
        Assert-True ($tpl -match 'Prompt rel %') "prompt rel column missing"
        Assert-True ($tpl -match 'Eval rel %') "eval rel column missing"
    }
}

Describe "Invoke-Report end-to-end on canned data" {
    # Set up a throwaway data dir, drop one canned result + plan, run report,
    # parse the embedded DATA blob and assert.
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "calibr-report-test-$([Guid]::NewGuid().ToString('N'))"
    $tmpData = Join-Path $tmpRoot "data"
    New-Item -ItemType Directory -Path (Join-Path $tmpData "results") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmpData "bats")    -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmpData "logs")    -Force | Out-Null

    $cannedResult = [ordered]@{
        id="T001_canned"; label="canned config"; model="cannedFam"; series="canned"; variant="Q4"; level="high"; sweep="context"
        prompt_tps=100.0; eval_tps=50.0; prompt_n=80; eval_n=128
        vram_peak_mib=2000; shared_peak_mib=0; load_sec=2.5
        kv_cache_mib=50; ctx_size=16384
        extra_args="--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0"
        ok=$true; fit_status="success"; layers_offloaded="32/32"
        wddm_vram_saturation=0.25; wddm_flag_shared_pos=$false; wddm_flag_high_vram=$false
        timestamp="2026-04-26T12:00:00"
        # Phase F additions: extended metrics + paths for client-side bat generation
        ttft_sec=0.42; gpu_power_peak_w=120.0; gpu_temp_peak_c=65; gpu_util_avg_pct=92
        prompt_ms=310.0; ttfr_ms=120.0; e2e_ttft_ms=420.0; total_request_ms=3360.0; latency_total_request_ms=520.0
        ram_used_peak_mib=1024; ram_baseline_mib=512
        vram_baseline_mib=900; vram_baseline_pct=0.1099; vram_total_peak_mib=2000; vram_process_peak_mib=1100; vram_external_peak_mib=900
        runs=@(
            @{ eval_tps=45.0 },
            @{ eval_tps=50.0 },
            @{ eval_tps=55.0 }
        )
        model_path="C:\fake\model.gguf"; mmproj_path=$null
    }
    $cannedResult | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $tmpData "results\T001_canned.json")
    $cannedPlan = @([ordered]@{
        id="T001_canned"; label="canned config"; model="cannedFam"; series="canned"; variant="Q4"; level="high"; sweep="context"
        extra_args="--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0"
        model_path="C:\fake\model.gguf"; mmproj_path=$null
    })
    $cannedPlan | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $tmpData "plan.json")

    # config.json that points the script at our temp data dir via overrides.
    # Easier: copy the script's environment and use a temp config file with
    # a canned llama_server_exe (path doesn't need to exist for `report`).
    $tmpCfg = Join-Path $tmpRoot "config.json"
    @{
        llama_server_exe = "C:\fake\llama-server.exe"
        scan_paths = @(".")
        hardware = @{
            auto_detect = $false
            vram_total_mib = 8192
            vram_safety_budget_mib = 7782
        }
    } | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $tmpCfg

    # Isolate the engine's writes from the user's real data/ by setting
    # CALIBR_DATA_DIR in the child env. Without this, a test failure (or
    # the simple fact that the engine writes report.html in this dir)
    # leaks the canned fixture into the user's report. The $env:* assign
    # only affects child processes spawned after this point - the parent
    # PowerShell's data dir is untouched.
    $env:CALIBR_DATA_DIR = $tmpData
    try {
        $labScript = Join-Path $labRoot "calibr.ps1"
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $labScript -Config $tmpCfg report 2>&1 | Out-String

        $reportPath = Join-Path $tmpData "report.html"
        $html = Get-Content $reportPath -Raw

        It "writes report.html" {
            Assert-True (Test-Path $reportPath)
        }
        It "embeds the new derived fields in DATA" {
            Assert-True ($html -match '"time_total_sec"') "DATA missing time_total_sec"
            Assert-True ($html -match '"headroom_mib"')   "DATA missing headroom_mib"
            Assert-True ($html -match '"ctx_size"')       "DATA missing ctx_size"
            Assert-True ($html -match '"kv_cache_mib"')   "DATA missing kv_cache_mib"
        }
        It "embeds the extended metrics for the scoring profiles (Phase F)" {
            Assert-True ($html -match '"ttft_sec"')           "DATA missing ttft_sec"
            Assert-True ($html -match '"prompt_ms"')          "DATA missing prompt_ms"
            Assert-True ($html -match '"ttfr_ms"')            "DATA missing ttfr_ms"
            Assert-True ($html -match '"e2e_ttft_ms"')        "DATA missing e2e_ttft_ms"
            Assert-True ($html -match '"total_request_ms"')   "DATA missing total_request_ms"
            Assert-True ($html -match '"gpu_power_peak_w"')   "DATA missing gpu_power_peak_w"
            Assert-True ($html -match '"gpu_temp_peak_c"')    "DATA missing gpu_temp_peak_c"
            Assert-True ($html -match '"gpu_util_avg_pct"')   "DATA missing gpu_util_avg_pct"
            Assert-True ($html -match '"cpu_util_avg_pct"')   "DATA missing cpu_util_avg_pct"
            Assert-True ($html -match '"ram_used_peak_mib"')  "DATA missing ram_used_peak_mib"
            Assert-True ($html -match '"model_cold_load_ms"') "DATA missing model cold-load metric"
            Assert-True ($html -match '"first_eval_tps"')     "DATA missing first_eval_tps"
            Assert-True ($html -match '"repeat_eval_tps"')    "DATA missing repeat_eval_tps"
            Assert-True ($html -match '"eval_spread_pct"')    "DATA missing eval_spread_pct"
        }
        It "embeds VRAM attribution fields for report tooltips" {
            Assert-True ($html -match '"vram_baseline_mib":900')      "DATA missing vram_baseline_mib"
            Assert-True ($html -match '"vram_baseline_pct":0\.1099')  "DATA missing vram_baseline_pct"
            Assert-True ($html -match '"vram_total_peak_mib":2000')   "DATA missing vram_total_peak_mib"
            Assert-True ($html -match '"vram_process_peak_mib":1100') "DATA missing vram_process_peak_mib"
            Assert-True ($html -match '"vram_external_peak_mib":900') "DATA missing vram_external_peak_mib"
        }
        It "embeds paths for client-side .bat generation (Phase F)" {
            Assert-True ($html -match '"model_path"')         "DATA missing model_path"
            Assert-True ($html -match '"mmproj_path"')        "DATA missing mmproj_path"
        }
        It "adds installed system RAM to the TypeScript-built report config" {
            Assert-True ($html -match '"system_ram_total_mib":\d+') "CFG missing system RAM total"
        }
        It "embeds failure-classification fields (so the report explains why a config failed)" {
            Assert-True ($html -match '"failure_reason"')             "DATA missing failure_reason"
            Assert-True ($html -match '"unsupported_architecture"')   "DATA missing unsupported_architecture"
            Assert-True ($html -match '"ready"')                      "DATA missing ready"
        }
        It "computes headroom = vram_total - vram_peak for the canned record" {
            # vram_total=8192, vram_peak=2000 -> headroom=6192
            Assert-True ($html -match '"headroom_mib":6192') "expected headroom 6192 for canned record"
        }
        It "preserves the scatter chart elements after substitution" {
            Assert-True ($html -match 'id="scatter"')
            Assert-True ($html -match 'function renderScatter')
        }
        It "preserves the filter selector after substitution (Phase F)" {
            Assert-True ($html -match 'data-filter="speed"')        "filter buttons stripped"
            Assert-True ($html -match 'function computeWinners')    "computeWinners function stripped"
        }
    } finally {
        # Drop the env override and wipe the whole temp tree. With the
        # CALIBR_DATA_DIR isolation no real-data cleanup is needed.
        Remove-Item Env:\CALIBR_DATA_DIR -ErrorAction SilentlyContinue
        if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "report.template.html script renders under a stubbed DOM" {
    # report-smoke.mjs extracts the <script> block, fills the
    # placeholders with a small canned dataset, and runs it under a stubbed
    # document. A syntax error or a runtime throw during the initial
    # rerender() exits non-zero. Catches the kind of typo that would
    # silently break the report when opened in a real browser.
    It "node smoke completes with exit code 0" {
        $node = (Get-Command node -ErrorAction SilentlyContinue)
        if (-not $node) {
            Write-Host "  [skip] node not on PATH" -ForegroundColor DarkYellow
            return
        }
        $smokeScript = Join-Path $PSScriptRoot "report-smoke.mjs"
        $stdout = & $node.Source $smokeScript 2>&1 | Out-String
        Assert-True ($LASTEXITCODE -eq 0) "report-smoke.mjs exited $LASTEXITCODE`: $stdout"
        Assert-True ($stdout -match 'OK: report\.template\.html renders') "expected OK line, got: $stdout"
    }
}

Exit-WithResults
