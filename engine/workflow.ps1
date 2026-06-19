# Guided-run workflow orchestration.
#
# The TypeScript CLI invokes `all` once. This module coordinates the internal
# PowerShell stages; those stages remain separate because they own distinct
# artifacts and tests, not because they are separate user journeys.

function Invoke-All {
    Ensure-WorkflowEngine

    if (-not $FetchCatalog) {
        Invoke-WorkflowBenchCycle
        Invoke-Report
        return
    }

    $catalogEntries = @(Resolve-WorkflowCatalogEntries)
    if ($catalogEntries.Count -eq 0) {
        Write-Host "No catalog entries match the current scope. Nothing to do." -ForegroundColor Yellow
        return
    }

    Ensure-WorkflowScanPath

    Write-Host ""
    Write-Host ("=== guided workflow: {0} catalog model(s), interleaved ===" -f $catalogEntries.Count) -ForegroundColor Cyan

    if (-not $CatalogId -and -not $Model) {
        Write-Host ""
        Write-Host "--- pre-existing models ---" -ForegroundColor DarkCyan
        Invoke-WorkflowBenchCycle
    }

    Invoke-CatalogWorkflow -CatalogEntries $catalogEntries

    Write-Host ""
    Write-Host "--- final report ---" -ForegroundColor DarkCyan
    Invoke-Report
}

function Ensure-WorkflowEngine {
    $config = Get-Config
    if (-not (Test-ConfigNeedsInit -cfg $config)) {
        return
    }

    Write-Host "[all] setup incomplete - running setup first..." -ForegroundColor Cyan
    $savedNonInteractive = $script:NonInteractive
    $savedForce = $script:Force
    $script:NonInteractive = $true
    $script:Force = $false

    try {
        Invoke-Init
    } catch {
        Write-Host ("[all] setup failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    } finally {
        $script:NonInteractive = $savedNonInteractive
        $script:Force = $savedForce
    }

    $config = Get-Config
    if (-not $config.llama_server_exe -or -not (Test-Path $config.llama_server_exe)) {
        throw "llama-server$script:ExeExt could not be configured. Use guided run to download or select llama.cpp, or run the raw init command with -AutoFetchLlama/-LlamaServer."
    }

    Write-Host ("[all] setup done. llama_server_exe = {0}" -f $config.llama_server_exe) -ForegroundColor Green
}

function Invoke-WorkflowBenchCycle {
    Invoke-Discover
    Invoke-Plan
    Invoke-Bench
}

function Resolve-WorkflowCatalogEntries {
    $entries = @(Get-ModelCatalog)

    # These values are consumed by plan.ps1. Clear them first so a second
    # workflow invocation in the same process cannot inherit an older preset.
    $script:_presetMaxCtx = 0
    $script:_presetCtxSizes = @()

    if ($Preset) {
        $presetObject = Get-Preset -Name $Preset
        if ($null -eq $presetObject) {
            $knownPresets = ((Get-PresetCatalog).Keys | Sort-Object) -join ', '
            throw "Preset '$Preset' not found. Known: $knownPresets"
        }

        $entries = @(Select-CatalogByPreset -catalog $entries -preset $presetObject)
        if ($null -ne $presetObject.max_ctx) {
            $script:_presetMaxCtx = [int]$presetObject.max_ctx
        }
        if ($presetObject.context_sizes) {
            $script:_presetCtxSizes = @($presetObject.context_sizes)
        }

        $maxContextLabel = if ($script:_presetMaxCtx -gt 0) { $script:_presetMaxCtx } else { '(no cap)' }
        Write-Host ("[all] preset '{0}': {1} entries, max_ctx={2}" -f $Preset, $entries.Count, $maxContextLabel) -ForegroundColor Cyan
    }

    if ($CatalogId) {
        $idPatterns = @(($CatalogId -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $entries = @($entries | Where-Object { Test-WorkflowCatalogId -Id $_.id -Patterns $idPatterns })
    }
    if ($Model) {
        $entries = @($entries | Where-Object { $_.model -match $Model })
    }

    return $entries
}

function Test-WorkflowCatalogId {
    param(
        [string]$Id,
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Id -like $pattern) {
            return $true
        }
    }
    return $false
}

function Ensure-WorkflowScanPath {
    $config = Get-Config
    $hasConfiguredPath = $config.scan_paths -and $config.scan_paths.Count -gt 0
    $hasCommandPath = $script:ScanPath -and $script:ScanPath.Count -gt 0
    if ($hasConfiguredPath -or $hasCommandPath) {
        return
    }

    $downloadPath = if ($Destination) { $Destination } else { $CALIBR_DOWNLOADED_MODELS_DIR }
    $script:ScanPath = @($downloadPath)
    Write-Host "[all] No model folder configured. Will use $downloadPath." -ForegroundColor Cyan
}

function Invoke-CatalogWorkflow {
    param([object[]]$CatalogEntries)

    $savedCatalogId = $script:CatalogId
    $savedModel = $script:Model

    try {
        for ($index = 0; $index -lt $CatalogEntries.Count; $index++) {
            Invoke-CatalogEntry `
                -Entry $CatalogEntries[$index] `
                -Number ($index + 1) `
                -Total $CatalogEntries.Count
        }
    } finally {
        $script:CatalogId = $savedCatalogId
        $script:Model = $savedModel
    }
}

function Invoke-CatalogEntry {
    param(
        [object]$Entry,
        [int]$Number,
        [int]$Total
    )

    $outerCatalogId = $script:CatalogId
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host ""
    Write-Host ("[sample {0}/{1}] {2}" -f $Number, $Total, $Entry.id)
    Write-Host ("--- model {0}/{1}: {2} ({3}) ---" -f $Number, $Total, $Entry.id, $Entry.model) -ForegroundColor Cyan

    $script:CatalogId = $Entry.id
    $script:Model = ""
    Invoke-FetchModels

    $script:CatalogId = $outerCatalogId
    Invoke-Discover
    Invoke-Plan

    $script:Model = $Entry.model
    Invoke-Bench

    $timer.Stop()
    Write-Host ("[sample-done {0}/{1}] {2} elapsed_ms={3}" -f $Number, $Total, $Entry.id, $timer.ElapsedMilliseconds)
}
