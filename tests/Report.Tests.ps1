# Smoke tests for the report template + Invoke-Report integration. Static
# checks against report.template.html catch most regressions cheaply; the
# data-derivation logic is unit-tested in Helpers.Tests.ps1.
. "$PSScriptRoot\harness.ps1"

$labRoot = (Resolve-Path "$PSScriptRoot\..").Path
$tplPath = Join-Path $labRoot "report.template.html"

Describe "report.template.html structure" {
    $tpl = Get-Content $tplPath -Raw

    It "exists and is non-empty" {
        Assert-True ($tpl.Length -gt 1000) "template should have meaningful content"
    }
    It "exposes the three placeholders Invoke-Report fills" {
        Assert-True ($tpl -match '%%DATA%%')     "missing %%DATA%% placeholder"
        Assert-True ($tpl -match '%%WINNERS%%')  "missing %%WINNERS%% placeholder"
        Assert-True ($tpl -match '%%CFG%%')      "missing %%CFG%% placeholder"
        Assert-True ($tpl -match '%%NOW%%')      "missing %%NOW%% placeholder"
    }
    It "embeds the new scatter section" {
        Assert-True ($tpl -match 'id="scatter"')          "scatter SVG element missing"
        Assert-True ($tpl -match 'function renderScatter') "renderScatter function missing"
        Assert-True ($tpl -match 'function modelColor')    "modelColor function missing"
        Assert-True ($tpl -match 'class="scatter-line-gpu"') "scatter-line-gpu CSS class missing"
        Assert-True ($tpl -match 'GPU VRAM \(')             "scatter chart should label the GPU VRAM reference line"
    }
    It "uses log-10 scale on the scatter X axis" {
        Assert-True ($tpl -match 'Math\.log10') "log-10 transform missing from renderScatter"
        Assert-True ($tpl -match 'log-10')      "X axis label should mention log-10 scale"
    }
    It "sorts the VRAM bar chart ascending" {
        Assert-True ($tpl -match "dir:\s*'asc'") "VRAM bars should be called with dir: 'asc'"
    }
    It "annotates VRAM bars with the headroom indicator" {
        Assert-True ($tpl -match 'function vramHeadroom')    "vramHeadroom function missing"
        Assert-True ($tpl -match 'annotate:\s*vramHeadroom') "VRAM bars should pass vramHeadroom as annotate"
        Assert-True ($tpl -match '\.bar-row-ann')            "bar-row-ann CSS class missing"
    }
    It "keeps the eval bar chart descending (top = fastest)" {
        $evalCallMatch = [regex]::Match($tpl, "bars\('eval-bars'[^)]*\)")
        Assert-True $evalCallMatch.Success "could not locate eval-bars call"
        Assert-False ($evalCallMatch.Value -match "dir:\s*'asc'") "eval-bars should not be ascending"
    }
}

Describe "Invoke-Report end-to-end on canned data" {
    # Set up a throwaway data dir, drop one canned result + plan, run report,
    # parse the embedded DATA blob and assert.
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "llm-lab-report-test-$([Guid]::NewGuid().ToString('N'))"
    $tmpData = Join-Path $tmpRoot "data"
    New-Item -ItemType Directory -Path (Join-Path $tmpData "results") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmpData "bats")    -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmpData "logs")    -Force | Out-Null

    $cannedResult = [ordered]@{
        id="T001_canned"; label="canned config"; model="cannedFam"; series="canned"; variant="Q4"; tier="A"
        prompt_tps=100.0; eval_tps=50.0; prompt_n=80; eval_n=128
        vram_peak_mib=2000; shared_peak_mib=0; load_sec=2.5
        kv_cache_mib=50; ctx_size=16384
        extra_args="--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0"
        ok=$true; fit_status="success"; layers_offloaded="32/32"
        wddm_vram_saturation=0.25; wddm_flag_shared_pos=$false; wddm_flag_high_vram=$false
        timestamp="2026-04-26T12:00:00"
    }
    $cannedResult | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $tmpData "results\T001_canned.json")
    $cannedPlan = @([ordered]@{
        id="T001_canned"; label="canned config"; model="cannedFam"; series="canned"; variant="Q4"; tier="A"
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

    # Run via subprocess. We need the script to use $tmpData as its data dir,
    # which is anchored to $LAB_ROOT. Since $LAB_ROOT == script dir, we have
    # to point the data dir override another way — but llm-lab doesn't expose
    # one. Workaround: run from the temp dir as cwd; LAB_ROOT is still the
    # script dir, so data/ lands there. Instead, we copy fixture into the
    # real data/ temporarily under a unique id and clean up after.
    $realData    = Join-Path $labRoot "data"
    $realResults = Join-Path $realData "results"
    $resName     = "T_canned_$([Guid]::NewGuid().ToString('N')).json"
    $resPath     = Join-Path $realResults $resName
    $cannedResult.id = "T_" + ([guid]::NewGuid().ToString("N").Substring(0,12))
    $cannedResult | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $resPath

    try {
        $labScript = Join-Path $labRoot "llm-lab.ps1"
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $labScript -Config $tmpCfg report 2>&1 | Out-String

        $reportPath = Join-Path $realData "report.html"
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
        It "computes headroom = vram_total - vram_peak for the canned record" {
            # vram_total=8192, vram_peak=2000 -> headroom=6192
            Assert-True ($html -match '"headroom_mib":6192') "expected headroom 6192 for canned record"
        }
        It "preserves the scatter chart elements after substitution" {
            Assert-True ($html -match 'id="scatter"')
            Assert-True ($html -match 'function renderScatter')
        }
    } finally {
        # Clean up the canned result so it doesn't pollute the user's actual
        # data set. Don't touch any of the user's real result files.
        if (Test-Path $resPath) { Remove-Item $resPath -Force -ErrorAction SilentlyContinue }
        if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Exit-WithResults
