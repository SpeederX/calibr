# Guided-run workflow orchestration.
#
# The TypeScript CLI invokes `all` once. This module coordinates the internal
# PowerShell stages; those stages remain separate because they own distinct
# artifacts and tests, not because they are separate user journeys.

function Invoke-All {
    Ensure-WorkflowEngine
    $planningPolicy = New-PlanningPolicy -ContextSizes (ConvertTo-ContextSizeList -Value $ContextSizes)

    if (-not $FetchCatalog) {
        Invoke-WorkflowBenchCycle -PlanningPolicy $planningPolicy
        Invoke-Report
        return
    }

    $scope = Resolve-WorkflowCatalogScope
    $catalogEntries = @($scope.entries)
    $planningPolicy = $scope.planning_policy
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
        Invoke-WorkflowBenchCycle -PlanningPolicy $planningPolicy
    }

    Invoke-CatalogWorkflow -CatalogEntries $catalogEntries -PlanningPolicy $planningPolicy

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
    param([hashtable]$PlanningPolicy)
    Invoke-Discover
    Invoke-Plan -PlanningPolicy $PlanningPolicy
    Invoke-Bench
}

function Resolve-WorkflowCatalogScope {
    $presetObject = $null
    if ($Preset) {
        $presetObject = Get-Preset -Name $Preset
        if ($null -eq $presetObject) {
            $knownPresets = ((Get-PresetCatalog).Keys | Sort-Object) -join ', '
            throw "Preset '$Preset' not found. Known: $knownPresets"
        }
    }

    $contextSizes = ConvertTo-ContextSizeList -Value $ContextSizes
    if ($contextSizes.Count -eq 0 -and $presetObject -and $presetObject.context_sizes) {
        $contextSizes = @($presetObject.context_sizes | ForEach-Object { [int]$_ })
    }
    $maxContext = if ($presetObject -and $null -ne $presetObject.max_ctx) { [int]$presetObject.max_ctx } else { 0 }
    $policy = New-PlanningPolicy -MaxContext $maxContext -ContextSizes $contextSizes
    $entries = @(Select-ModelCatalog -Catalog (Get-ModelCatalog) -Preset $presetObject -CatalogId $CatalogId -ModelRegex $Model)

    if ($Preset) {
        $maxContextLabel = if ($maxContext -gt 0) { $maxContext } else { '(no cap)' }
        Write-Host ("[all] preset '{0}': {1} entries, max_ctx={2}" -f $Preset, $entries.Count, $maxContextLabel) -ForegroundColor Cyan
    }

    return @{
        entries = $entries
        planning_policy = $policy
    }
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
    param(
        [object[]]$CatalogEntries,
        [hashtable]$PlanningPolicy
    )

    $savedCatalogId = $script:CatalogId
    $savedModel = $script:Model

    try {
        for ($index = 0; $index -lt $CatalogEntries.Count; $index++) {
            Invoke-CatalogEntry `
                -Entry $CatalogEntries[$index] `
                -Number ($index + 1) `
                -Total $CatalogEntries.Count `
                -PlanningPolicy $PlanningPolicy
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
        [int]$Total,
        [hashtable]$PlanningPolicy
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
    Invoke-Plan -PlanningPolicy $PlanningPolicy

    $script:Model = $Entry.model
    Invoke-Bench

    $timer.Stop()
    Write-Host ("[sample-done {0}/{1}] {2} elapsed_ms={3}" -f $Number, $Total, $Entry.id, $timer.ElapsedMilliseconds)
}
