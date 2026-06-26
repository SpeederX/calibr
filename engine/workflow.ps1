# Guided-run workflow orchestration.
#
# The TypeScript CLI invokes `all` once. This module coordinates the internal
# PowerShell stages; those stages remain separate because they own distinct
# artifacts and tests, not because they are separate user journeys.

function Invoke-All {
    Ensure-WorkflowEngine
    $planningPolicy = New-PlanningPolicy `
        -ContextSizes (ConvertTo-ContextSizeList -Value $ContextSizes) `
        -WorkloadSweep $WorkloadSweep

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

    # Catalog-download mode benchmarks exactly the resolved catalog scope. The
    # scan folder is only a download cache: Invoke-CatalogWorkflow reuses a model
    # already present there and fetches the rest from Hugging Face, benching each
    # entry on its own. Models in the folder that are outside the scope are not
    # benchmarked - that is what "local folder" mode (the -not $FetchCatalog
    # branch above) is for.
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
    if ((Add-MoeWorkloadDiagnostics -PlanningPolicy $PlanningPolicy) -gt 0) {
        Invoke-Bench
    }
}

function Add-MoeWorkloadDiagnostics {
    param([hashtable]$PlanningPolicy)

    $mode = if ($PlanningPolicy.workload_sweep) { [string]$PlanningPolicy.workload_sweep } else { 'baseline' }
    if ($mode -eq 'baseline' -or -not (Test-Path $CALIBR_PLAN)) { return 0 }

    $cfg = Get-Config
    $plan = @(Get-Content $CALIBR_PLAN -Raw | ConvertFrom-Json | ForEach-Object { $_ })
    $existingIds = @{}
    foreach ($item in $plan) { $existingIds[[string]$item.id] = $true }
    $added = @()

    $groups = @($plan | Where-Object {
        $_.sweep -eq 'moe-cpu' -and
        -not $_.control_kind -and
        ((-not $_.workload_kind) -or $_.workload_kind -eq 'baseline')
    } | Group-Object model_path)

    foreach ($group in $groups) {
        $measured = @()
        foreach ($item in @($group.Group)) {
            $resultPath = Join-Path $CALIBR_RESULTS_DIR "$($item.id).json"
            if (-not (Test-Path $resultPath)) { continue }
            $result = Get-Content $resultPath -Raw | ConvertFrom-Json
            if ($result.ok -and [double]$result.eval_tps -gt 0) {
                $measured += [pscustomobject]@{ item = $item; result = $result }
            }
        }
        if ($measured.Count -eq 0) { continue }

        # Diagnostics follow the empirically fastest baseline placement. This
        # keeps the second pass bounded while testing the configuration users
        # would actually launch, instead of multiplying every MoE candidate by
        # every prefill/KV target.
        $anchor = @($measured | Sort-Object `
            @{ Expression = { [double]$_.result.eval_tps }; Descending = $true }, `
            @{ Expression = { [double]$_.result.prompt_tps }; Descending = $true } |
            Select-Object -First 1)[0]
        $source = $anchor.item
        $ctx = if ([string]$source.extra_args -match '--ctx-size\s+(\d+)') {
            [int]$Matches[1]
        } elseif ($cfg.planning.moe_planning.context_size) {
            [int]$cfg.planning.moe_planning.context_size
        } else { 16384 }

        foreach ($profile in @(Get-WorkloadProfilesForContext -ContextSize $ctx -Config $cfg -Mode $mode)) {
            $target = if ($profile.kind -eq 'prefill') { [int]$profile.prefill_tokens } else { [int]$profile.kv_fill_tokens }
            $suffix = if ($profile.kind -eq 'prefill') { "prefill_$target" } else { "kvfill_$target" }
            $id = "$($source.id)__$suffix"
            if ($existingIds.ContainsKey($id)) { continue }

            $clone = [ordered]@{}
            foreach ($property in $source.PSObject.Properties) {
                $clone[$property.Name] = $property.Value
            }
            $clone.id = $id
            $clone.label = "$($source.label) [$($profile.kind)=$target]"
            $clone.workload_kind = $profile.kind
            $clone.prefill_target_tokens = [int]$profile.prefill_tokens
            $clone.kv_fill_target_tokens = [int]$profile.kv_fill_tokens
            $clone.diagnostic_source_id = $source.id
            $added += [pscustomobject]$clone
            $existingIds[$id] = $true
        }
    }

    if ($added.Count -eq 0) { return 0 }
    $combinedPlan = @($plan) + @($added)
    ConvertTo-Json -InputObject @($combinedPlan) -Depth 10 | Out-File -Encoding utf8 $CALIBR_PLAN
    Write-Host ("[plan] added {0} MoE workload diagnostics from empirical speed winner(s)" -f $added.Count) -ForegroundColor Cyan
    return $added.Count
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
    $policy = New-PlanningPolicy `
        -MaxContext $maxContext `
        -ContextSizes $contextSizes `
        -WorkloadSweep $WorkloadSweep
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
    if ((Add-MoeWorkloadDiagnostics -PlanningPolicy $PlanningPolicy) -gt 0) {
        Invoke-Bench
    }

    $timer.Stop()
    Write-Host ("[sample-done {0}/{1}] {2} elapsed_ms={3}" -f $Number, $Total, $Entry.id, $timer.ElapsedMilliseconds)
}
