# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: plan
# ============================================================================
function Get-SweepKind {
    param($meta, $cfg)
    return Get-FallbackSweepKind -Meta $meta -Config $cfg
}

function Get-CatalogLevelMap {
    # Builds {hf_file.ToLower() -> level} where level is the hardware preset
    # (low / middle / high / ultra) a curated model belongs to. The presets
    # partition the curated catalog disjointly, so each model maps to exactly
    # one level. User-owned models (not in models_catalog.json) get no level
    # (lookup miss -> $null), which is correct: 'level' is a curated concept.
    $map = @{}
    try {
        $catalog = Get-ModelCatalog
        $byId = @{}
        foreach ($e in $catalog) { if ($e.id -and $e.hf_file) { $byId[$e.id] = $e.hf_file } }
        $presets = Get-PresetCatalog
        foreach ($lvl in @('low','middle','high','ultra')) {
            $p = $presets[$lvl]
            if (-not $p -or -not $p.models) { continue }
            if ($p.models -is [string] -and $p.models -eq '*') { continue }
            foreach ($id in @($p.models)) {
                if ($byId.ContainsKey($id)) { $map[$byId[$id].ToLower()] = $lvl }
            }
        }
    } catch { }
    return $map
}

function New-PlanningPolicy {
    param(
        [int]$MaxContext = 0,
        [int[]]$ContextSizes = @(),
        [ValidateSet("baseline", "prefill", "kv-fill", "all")]
        [string]$WorkloadSweep = "baseline"
    )

    return @{
        max_context  = $MaxContext
        context_sizes = @($ContextSizes)
        workload_sweep = $WorkloadSweep
    }
}

function ConvertTo-ContextSizeList {
    param([string]$Value)
    if (-not $Value) { return @() }
    return @(($Value -split ',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -match '^\d+$' } |
        ForEach-Object { [int]$_ })
}

function Get-PlanWorkloadIdentity {
    param(
        [ValidateSet("baseline", "prefill", "kv-fill")]
        [string]$Kind = "baseline",
        [int]$PrefillTokens = 0,
        [int]$KvFillTokens = 0
    )

    if ($Kind -eq "prefill") { return "prefill=$PrefillTokens" }
    if ($Kind -eq "kv-fill") { return "kvfill=$KvFillTokens" }
    return ""
}

function Get-WorkloadProfilesForContext {
    param(
        [int]$ContextSize,
        $Config,
        [ValidateSet("baseline", "prefill", "kv-fill", "all")]
        [string]$Mode = "baseline"
    )

    if ($Mode -eq "baseline") { return @() }
    $settings = $Config.planning.workload_sweeps
    $reserve = if ($settings -and $null -ne $settings.context_reserve_tokens) {
        [int]$settings.context_reserve_tokens
    } else { 512 }
    $nPredict = if ($Config.bench -and $null -ne $Config.bench.n_predict) {
        [int]$Config.bench.n_predict
    } else { 128 }
    $maxTarget = [math]::Max(0, $ContextSize - $reserve - $nPredict)
    $profiles = @()

    if ($Mode -eq "prefill" -or $Mode -eq "all") {
        foreach ($target in @($settings.prefill_tokens)) {
            $tokens = [int]$target
            if ($tokens -gt 0 -and $tokens -le $maxTarget) {
                $profiles += @{ kind = "prefill"; prefill_tokens = $tokens; kv_fill_tokens = 0 }
            }
        }
    }
    if ($Mode -eq "kv-fill" -or $Mode -eq "all") {
        foreach ($ratioValue in @($settings.kv_fill_ratios)) {
            $ratio = [double]$ratioValue
            $tokens = [int][math]::Floor($ContextSize * $ratio)
            if ($ratio -gt 0 -and $ratio -lt 1 -and $tokens -gt 0 -and $tokens -le $maxTarget) {
                $profiles += @{ kind = "kv-fill"; prefill_tokens = 0; kv_fill_tokens = $tokens }
            }
        }
    }
    return @($profiles)
}

function New-PlanItem {
    param(
        $meta,
        $sweep,
        $level,
        $extraArgs,
        $label,
        $idx,
        [ValidateSet("baseline", "prefill", "kv-fill")]
        [string]$WorkloadKind = "baseline",
        [int]$PrefillTokens = 0,
        [int]$KvFillTokens = 0,
        $Calibration = $null,
        [string]$CalibrationId = "",
        $FitOffset = $null
    )
    # IDs used to be 'T{idx:D3}_{model_variant}_{label}'. The idx prefix made
    # them NON-deterministic across plan regenerations: re-running discover
    # with a different catalog (or the per-sample loop in 'all -FetchCatalog'
    # where each iteration plans against a single model) shifted idx and
    # produced new IDs for the SAME logical config. Two consequences in the
    # wild:
    #   1. result JSONs accumulated in data/results/ with the same suffix but
    #      different idx, and the report rendered them as visual duplicates
    #      (one bar per file, same model + same config).
    #   2. cache hits missed across plan regenerations because the cache check
    #      is keyed off the ID, so the same config got re-benched.
    # The fix: ID is now '{model_variant}__{label}' - deterministic over
    # (model, variant, label), which is unique within any single plan. The
    # `$idx` param is kept for backwards compat with callers but unused.
    $sanitizedModel = ($meta.model + "_" + $meta.variant) -replace '[^\w]', '_'
    $workloadIdentity = Get-PlanWorkloadIdentity -Kind $WorkloadKind -PrefillTokens $PrefillTokens -KvFillTokens $KvFillTokens
    $identityLabel = if ($workloadIdentity) { "${label}_${workloadIdentity}" } else { $label }
    $sanitizedLabel = $identityLabel -replace '[^\w]', '_'
    if ($sanitizedModel.Length -gt 40) { $sanitizedModel = $sanitizedModel.Substring(0, 40) }
    if ($sanitizedLabel.Length -gt 80) { $sanitizedLabel = $sanitizedLabel.Substring(0, 80) }
    $id = "{0}__{1}" -f $sanitizedModel, $sanitizedLabel
    $item = @{
        id          = $id
        model_path  = $meta.path
        mmproj_path = $meta.mmproj
        model       = $meta.model
        variant     = $meta.variant
        series      = $meta.series
        sweep       = $sweep
        level       = $level
        reasoning_mode = $meta.reasoning_mode
        template_note = $meta.template_note
        gguf_context_length = $meta.gguf_context_length
        gguf_architecture = $meta.gguf_architecture
        workload_kind = $WorkloadKind
        prefill_target_tokens = $PrefillTokens
        kv_fill_target_tokens = $KvFillTokens
        label       = "$($meta.model) $($meta.variant) @ $identityLabel"
        extra_args  = $extraArgs
    }
    if ($Calibration -and $Calibration.calibrated) {
        $item.planning_mode = "adaptive-offload"
        $item.calibration_id = $CalibrationId
        $item.predicted_fit_layers = $Calibration.predicted_fit_layers
        $item.verified_fit_layers = $Calibration.verified_fit_layers
        $item.first_spill_layers = $Calibration.first_spill_layers
        $item.probe_count = $Calibration.probe_count
        $item.fit_offset = $FitOffset
        $item.calibration_cache_hit = [bool]$Calibration.cache_hit
        $item.calibration_cache_age_hours = $Calibration.cache_age_hours
    }
    return $item
}

function Get-CatalogMaxContextMap {
    # Builds a hashtable {hf_file.ToLower() -> max_context (int)} from
    # models_catalog.json. Used by Invoke-Plan to skip context candidates above
    # the model's officially-supported ctx. User-owned models (not in
    # models_catalog.json by basename) fall through to the global max_context_cap
    # only - a per-model cap for those would require reading GGUF metadata,
    # which is a separate (larger) piece of work.
    $samples = Get-ModelCatalog
    $map = @{}
    foreach ($s in $samples) {
        if ($null -ne $s.max_context -and $s.hf_file) {
            $map[$s.hf_file.ToLower()] = [int]$s.max_context
        }
    }
    return $map
}

function Test-CtxAllowedForModel {
    # Pure predicate: returns $true iff $ctx is allowed by both caps.
    # 0 disables either cap (matches Invoke-Plan's existing convention
    # for max_context_cap). Both caps are upper bounds; <=  passes,
    # > fails.
    param(
        [Parameter(Mandatory)][int]$Ctx,
        [int]$GlobalCap = 0,
        [int]$PerModelCap = 0
    )
    if ($GlobalCap   -gt 0 -and $Ctx -gt $GlobalCap)   { return $false }
    if ($PerModelCap -gt 0 -and $Ctx -gt $PerModelCap) { return $false }
    return $true
}

function Invoke-Plan {
    param([hashtable]$PlanningPolicy = $null)

    $cfg = Get-Config
    Write-Host "=== plan ===" -ForegroundColor Cyan
    if (-not (Test-Path $CALIBR_CATALOG)) { throw "catalog.json missing. Run: calibr discover" }
    $catRaw = Get-Content $CALIBR_CATALOG -Raw | ConvertFrom-Json
    $catalog = ConvertTo-Hashtable -obj $catRaw

    $threadsArg = ""
    if ($cfg.hardware.cpu_cores_physical) {
        $threadsArg = " --threads $($cfg.hardware.cpu_cores_physical) --threads-batch $($cfg.hardware.cpu_threads_logical)"
    }
    $base = $cfg.base_args + $threadsArg

    $globalCtxCap = if ($null -ne $cfg.max_context_cap) { [int]$cfg.max_context_cap } else { 0 }
    if ($null -eq $PlanningPolicy) {
        $PlanningPolicy = New-PlanningPolicy `
            -ContextSizes (ConvertTo-ContextSizeList -Value $ContextSizes) `
            -WorkloadSweep $WorkloadSweep
    }
    if ($PlanningPolicy.max_context -and [int]$PlanningPolicy.max_context -gt 0) {
        $presetCap = [int]$PlanningPolicy.max_context
        if ($globalCtxCap -eq 0 -or $presetCap -lt $globalCtxCap) {
            $globalCtxCap = $presetCap
        }
    }
    $perModelCaps = Get-CatalogMaxContextMap
    $levelMap = Get-CatalogLevelMap

    # Effective context candidates for the context sweep. The caller passes
    # session policy explicitly; direct raw plan calls derive it from
    # -ContextSizes. KV per size comes from the matching default, else q8_0.
    $ctxCandidates = $cfg.context_candidates
    $ctxOverride = @($PlanningPolicy.context_sizes | ForEach-Object { [int]$_ })
    if ($ctxOverride -and $ctxOverride.Count -gt 0) {
        $kvByCtx = @{}
        foreach ($c in $cfg.context_candidates) { $kvByCtx[[int]$c.ctx] = $c.kv }
        $ctxCandidates = @($ctxOverride | ForEach-Object { @{ ctx = $_; kv = $(if ($kvByCtx.ContainsKey($_)) { $kvByCtx[$_] } else { 'q8_0' }) } })
    }

    $plan = @()
    $idx = 1
    foreach ($m in $catalog) {
        if ($Model -and $m.model -notmatch $Model) { continue }
        $sweep = Get-SweepKind -meta $m -cfg $cfg
        $calibration = $null
        $calibrationId = ""
        $bnameLvl = [System.IO.Path]::GetFileName($m.path)
        $level = if ($bnameLvl -and $levelMap.ContainsKey($bnameLvl.ToLower())) { $levelMap[$bnameLvl.ToLower()] } else { $null }
        if ($Level -and $level -ne $Level) { continue }
        if (-not $m.is_moe -and -not $DryRun) {
            $offloadSettings = $cfg.planning.offload_planning
            $probeCtx = if ($offloadSettings.context_size) { [int]$offloadSettings.context_size } else { 16384 }
            $probeKv = if ($offloadSettings.kv_type) { [string]$offloadSettings.kv_type } else { "q8_0" }
            $calibrationId = Get-OffloadCalibrationId `
                -Meta $m -Config $cfg -BaseArgs $base -ContextSize $probeCtx -KvType $probeKv
            $calibration = Get-CachedOffloadCalibration -CalibrationId $calibrationId -Config $cfg
            if (-not $calibration) {
                $calibration = Invoke-TsOffloadCalibration -Meta $m -Config $cfg -BaseArgs $base
                if ($calibration) { $calibration.cache_hit = $false }
            }
            if ($calibration -and $calibration.calibrated) {
                $sweep = [string]$calibration.mode
                if (-not $calibration.cache_hit) {
                    Save-OffloadCalibration `
                        -CalibrationId $calibrationId -Result $calibration -Meta $m -Config $cfg `
                        -BaseArgs $base -ContextSize $probeCtx -KvType $probeKv
                }
                $source = if ($calibration.cache_hit) { "cached" } else { "$($calibration.probe_count) probes" }
                Write-Host ("  adaptive offload: {0}, fit {1}/{2} layers ({3})" -f `
                    $m.model, $calibration.verified_fit_layers, $calibration.block_count, $source) `
                    -ForegroundColor DarkCyan
            } elseif ($calibration) {
                Write-Host ("  adaptive offload fallback for {0}: {1}" -f $m.model, $calibration.reason) `
                    -ForegroundColor DarkYellow
            }
        }

        # Per-model ctx cap if the .gguf basename matches a curated sample.
        # User-owned files won't match -> $perModelCap stays 0 -> only the
        # global cap applies.
        $perModelCap = 0
        $bname = [System.IO.Path]::GetFileName($m.path)
        if ($bname -and $perModelCaps.ContainsKey($bname.ToLower())) {
            $perModelCap = $perModelCaps[$bname.ToLower()]
        } elseif ($m.gguf_context_length) {
            $perModelCap = [int]$m.gguf_context_length
        }

        switch ($sweep) {
            "context" {
                $skipped = 0
                $modelCandidates = @($ctxCandidates)
                if (-not $ctxOverride -and $perModelCap -gt 0 -and
                    ($globalCtxCap -eq 0 -or $perModelCap -le $globalCtxCap) -and
                    @($ctxCandidates | Where-Object { [int]$_.ctx -eq $perModelCap }).Count -eq 0) {
                    $next = @($ctxCandidates | Where-Object { [int]$_.ctx -gt $perModelCap } | Sort-Object { [int]$_.ctx } | Select-Object -First 1)
                    $fallback = @($ctxCandidates | Sort-Object { [int]$_.ctx } | Select-Object -Last 1)
                    $kv = if ($next.Count -gt 0) { $next[0].kv } elseif ($fallback.Count -gt 0) { $fallback[0].kv } else { 'q8_0' }
                    $modelCandidates = @($ctxCandidates) + @(@{ ctx = $perModelCap; kv = $kv })
                    $modelCandidates = @($modelCandidates | Sort-Object { [int]$_.ctx })
                }
                $validCandidates = @()
                foreach ($c in $modelCandidates) {
                    if (-not (Test-CtxAllowedForModel -Ctx ([int]$c.ctx) -GlobalCap $globalCtxCap -PerModelCap $perModelCap)) {
                        $skipped++
                        continue
                    }
                    $validCandidates += $c
                    $fitArg = if ($calibration -and $calibration.calibrated) { " --fit off" } else { "" }
                    $argStr = "--ctx-size $($c.ctx) --gpu-layers 99 --cache-type-k $($c.kv) --cache-type-v $($c.kv) $base$fitArg"
                    $plan += (New-PlanItem `
                        -meta $m -sweep $sweep -level $level -extraArgs $argStr `
                        -label "ctx=$($c.ctx)_kv=$($c.kv)" -idx $idx `
                        -Calibration $calibration -CalibrationId $calibrationId)
                    $idx++
                }
                $anchor = @($validCandidates | Sort-Object { [int]$_.ctx } | Select-Object -Last 1)
                if ($anchor.Count -gt 0) {
                    $anchorCtx = [int]$anchor[0].ctx
                    $anchorKv = $anchor[0].kv
                    $fitArg = if ($calibration -and $calibration.calibrated) { " --fit off" } else { "" }
                    $argStr = "--ctx-size $anchorCtx --gpu-layers 99 --cache-type-k $anchorKv --cache-type-v $anchorKv $base$fitArg"
                    $profiles = @(Get-WorkloadProfilesForContext `
                        -ContextSize $anchorCtx `
                        -Config $cfg `
                        -Mode $PlanningPolicy.workload_sweep)
                    foreach ($profile in $profiles) {
                        $target = if ($profile.kind -eq "prefill") { $profile.prefill_tokens } else { $profile.kv_fill_tokens }
                        $label = "ctx=${anchorCtx}_kv=${anchorKv}"
                        $plan += (New-PlanItem `
                            -meta $m -sweep $sweep -level $level -extraArgs $argStr -label $label -idx $idx `
                            -WorkloadKind $profile.kind `
                            -PrefillTokens $profile.prefill_tokens `
                            -KvFillTokens $profile.kv_fill_tokens `
                            -Calibration $calibration `
                            -CalibrationId $calibrationId)
                        $idx++
                    }
                }
                if ($skipped -gt 0 -and $perModelCap -gt 0) {
                    Write-Host ("  skipped {0} context candidates above {1}'s max_context ({2})" -f $skipped, $m.model, $perModelCap) -ForegroundColor DarkGray
                }
            }
            "moe-cpu" {
                foreach ($n in $cfg.planning.moecpu_sweep) {
                    $argStr = "--ctx-size 16384 --gpu-layers 99 --n-cpu-moe $n --cache-type-k q8_0 --cache-type-v q8_0 $base"
                    $plan += (New-PlanItem -meta $m -sweep $sweep -level $level -extraArgs $argStr -label "ncpumoe_$n" -idx $idx); $idx++
                }
            }
            "offload" {
                $layers = if ($calibration -and $calibration.calibrated) {
                    @($calibration.benchmark_layers | ForEach-Object { [int]$_ })
                } else {
                    @(Get-FallbackOffloadLayers)
                }
                $offloadSettings = $cfg.planning.offload_planning
                $offloadCtx = if ($offloadSettings.context_size) { [int]$offloadSettings.context_size } else { 16384 }
                $offloadKv = if ($offloadSettings.kv_type) { [string]$offloadSettings.kv_type } else { "q8_0" }
                foreach ($n in $layers) {
                    $fitArg = if ($calibration -and $calibration.calibrated) { " --fit off" } else { "" }
                    $argStr = "--ctx-size $offloadCtx --gpu-layers $n --cache-type-k $offloadKv --cache-type-v $offloadKv $base$fitArg"
                    $fitOffset = if ($calibration -and $calibration.calibrated) {
                        [int]$n - [int]$calibration.verified_fit_layers
                    } else { $null }
                    $plan += (New-PlanItem `
                        -meta $m -sweep $sweep -level $level -extraArgs $argStr `
                        -label "ngl_$n" -idx $idx -Calibration $calibration `
                        -CalibrationId $calibrationId -FitOffset $fitOffset)
                    $idx++
                }
            }
        }
    }

    $plan | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $CALIBR_PLAN
    Write-Host ("Plan: {0} test configs -> {1}" -f $plan.Count, $CALIBR_PLAN) -ForegroundColor Green
    if ($DryRun) {
        $plan | ForEach-Object { Write-Host ("  [{0}] {1}" -f $(if ($_.level) { $_.level } else { 'custom' }), $_.label) }
    }
}


