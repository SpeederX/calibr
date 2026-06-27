# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: plan
# ============================================================================
function Get-SweepKind {
    param($meta, $cfg)
    return Get-FallbackSweepKind -Meta $meta -Config $cfg
}

function Resolve-TsLlamaCompatibilityScript {
    $candidates = @(
        (Join-Path $script:CALIBR_ROOT "cli\dist\engine\bench\llamaCompatibilityCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\engine\bench\llamaCompatibilityCli.js")
    )
    return @($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)[0]
}

function Get-LlamaArgumentCapabilities {
    param($Config)
    if (-not $Config.llama_server_exe -or -not (Test-Path $Config.llama_server_exe)) { return $null }
    $scriptPath = Resolve-TsLlamaCompatibilityScript
    if (-not $scriptPath) { return $null }
    try {
        $json = & node $scriptPath $Config.llama_server_exe
        if (-not $json) { return $null }
        return ($json | ConvertFrom-Json)
    } catch {
        Write-Host ("  llama.cpp compatibility inspection failed: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow
        return $null
    }
}

function Test-LlamaArgumentOption {
    param($Capabilities, [string[]]$Names)
    if (-not $Capabilities -or -not $Capabilities.options) { return $true }
    foreach ($name in $Names) {
        if (@($Capabilities.options) -contains $name) { return $true }
    }
    return $false
}

function Resolve-CompatibleKvType {
    param([string]$Requested, $Allowed)
    $values = @($Allowed | ForEach-Object { [string]$_ })
    if ($values.Count -eq 0 -or $values -contains $Requested) { return $Requested }
    foreach ($fallback in @('q8_0', 'f16')) {
        if ($values -contains $fallback) { return $fallback }
    }
    return $values[0]
}

function Get-CompatibleContextCandidateKv {
    param($Candidate, $Capabilities)
    $kv = Get-ContextCandidateKv -Candidate $Candidate
    if (-not $Capabilities) { return $kv }
    $k = Resolve-CompatibleKvType -Requested $kv.k -Allowed $Capabilities.cacheTypesK
    $v = Resolve-CompatibleKvType -Requested $kv.v -Allowed $Capabilities.cacheTypesV
    return @{
        k = $k
        v = $v
        label = $(if ($k -eq $v) { "kv=$k" } else { "kvk=${k}_kvv=$v" })
    }
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

function Get-ContextCandidateKv {
    param($Candidate)
    $fallback = if ($Candidate.kv) { [string]$Candidate.kv } else { "q8_0" }
    $k = if ($Candidate.kv_k) { [string]$Candidate.kv_k } else { $fallback }
    $v = if ($Candidate.kv_v) { [string]$Candidate.kv_v } else { $fallback }
    return @{
        k = $k
        v = $v
        label = $(if ($k -eq $v) { "kv=$k" } else { "kvk=${k}_kvv=$v" })
    }
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
    $profiles = [System.Collections.ArrayList]::new()
    $seen = @{}
    function Add-WorkloadProfile {
        param([hashtable]$Profile)
        $target = if ($Profile.kind -eq "prefill") { [int]$Profile.prefill_tokens } else { [int]$Profile.kv_fill_tokens }
        $key = "$($Profile.kind):$target"
        if ($seen.ContainsKey($key)) { return }
        [void]$profiles.Add($Profile)
        $seen[$key] = $true
    }

    if ($Mode -eq "prefill" -or $Mode -eq "all") {
        $microTargets = if ($settings.prefill_micro_tokens) {
            @($settings.prefill_micro_tokens)
        } elseif ($settings.prefill_ratios) {
            @(2048)
        } elseif ($settings.prefill_tokens) {
            @($settings.prefill_tokens)
        } else { @(2048) }
        foreach ($target in @($microTargets)) {
            $tokens = [int]$target
            if ($tokens -gt 0 -and $tokens -le $maxTarget) {
                Add-WorkloadProfile @{ kind = "prefill"; prefill_tokens = $tokens; kv_fill_tokens = 0 }
            }
        }
        foreach ($ratioValue in @($settings.prefill_ratios)) {
            $ratio = [double]$ratioValue
            $tokens = [int][math]::Floor($ContextSize * $ratio)
            if ($ratio -gt 0 -and $ratio -lt 1 -and $tokens -gt 0 -and $tokens -le $maxTarget) {
                Add-WorkloadProfile @{ kind = "prefill"; prefill_tokens = $tokens; kv_fill_tokens = 0 }
            }
        }
    }
    if ($Mode -eq "kv-fill" -or $Mode -eq "all") {
        foreach ($ratioValue in @($settings.kv_fill_ratios)) {
            $ratio = [double]$ratioValue
            $tokens = [int][math]::Floor($ContextSize * $ratio)
            if ($ratio -gt 0 -and $ratio -lt 1 -and $tokens -gt 0 -and $tokens -le $maxTarget) {
                Add-WorkloadProfile @{ kind = "kv-fill"; prefill_tokens = 0; kv_fill_tokens = $tokens }
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
        [ValidateSet("", "vanilla", "vanilla-matched", "vanilla-adjacent")]
        [string]$ControlKind = "",
        $Calibration = $null,
        [string]$CalibrationId = "",
        $FitOffset = $null,
        [ValidateSet("", "kv_rescue")]
        [string]$ConditionalKind = "",
        [string]$ConditionalSourceId = ""
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
        control_kind = $(if ($ControlKind) { $ControlKind } else { $null })
        conditional_kind = $(if ($ConditionalKind) { $ConditionalKind } else { $null })
        conditional_source_id = $(if ($ConditionalSourceId) { $ConditionalSourceId } else { $null })
        prefill_target_tokens = $PrefillTokens
        kv_fill_target_tokens = $KvFillTokens
        label       = "$($meta.model) $($meta.variant) @ $identityLabel"
        extra_args  = $extraArgs
    }
    if ($Calibration -and $Calibration.calibrated) {
        $item.planning_mode = if ($Calibration.planning_mode) { $Calibration.planning_mode } else { "adaptive-offload" }
        $item.calibration_id = $CalibrationId
        if ($item.planning_mode -eq "adaptive-moe") {
            $item.predicted_n_cpu_moe = $Calibration.predicted_n_cpu_moe
            $item.verified_n_cpu_moe = $Calibration.verified_n_cpu_moe
            $item.first_spill_n_cpu_moe = $Calibration.first_spill_n_cpu_moe
        } else {
            $item.predicted_fit_layers = $Calibration.predicted_fit_layers
            $item.verified_fit_layers = $Calibration.verified_fit_layers
            $item.first_spill_layers = $Calibration.first_spill_layers
        }
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
    Write-Host "=== planning & load calibration ===" -ForegroundColor Cyan
    $llamaCapabilities = Get-LlamaArgumentCapabilities -Config $cfg
    if ($llamaCapabilities) {
        Write-Host ("  llama.cpp compatibility: {0} options, K cache [{1}], V cache [{2}]" -f `
            @($llamaCapabilities.options).Count, `
            (@($llamaCapabilities.cacheTypesK) -join ','), `
            (@($llamaCapabilities.cacheTypesV) -join ',')) -ForegroundColor DarkGray
    }
    $supportsMoe = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--n-cpu-moe', '-ncmoe')
    $supportsCacheK = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--cache-type-k', '-ctk')
    $supportsCacheV = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--cache-type-v', '-ctv')
    $supportsFit = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--fit', '-fit')
    $supportsCacheRam = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--cache-ram', '-cram')
    $supportsNoWarmup = Test-LlamaArgumentOption -Capabilities $llamaCapabilities -Names @('--no-warmup')
    $supportsAdaptiveProbe = $supportsFit -and $supportsCacheK -and $supportsCacheV -and $supportsCacheRam -and $supportsNoWarmup
    if (-not (Test-Path $CALIBR_CATALOG)) { throw "catalog.json missing. Run: calibr discover" }
    $catRaw = Get-Content $CALIBR_CATALOG -Raw | ConvertFrom-Json
    $catalog = ConvertTo-Hashtable -obj $catRaw

    $threadsArg = ""
    if ($cfg.hardware.cpu_cores_physical) {
        $threadsArg = " --threads $($cfg.hardware.cpu_cores_physical) --threads-batch $($cfg.hardware.cpu_threads_logical)"
    }
    $base = $cfg.base_args + $threadsArg

    $absoluteCtxCap = if ($null -ne $cfg.max_context_cap) { [int]$cfg.max_context_cap } else { 0 }
    $globalCtxCap = $absoluteCtxCap
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
        foreach ($c in $cfg.context_candidates) {
            $kvByCtx[[int]$c.ctx] = Get-CompatibleContextCandidateKv -Candidate $c -Capabilities $llamaCapabilities
        }
        $ctxCandidates = @($ctxOverride | ForEach-Object {
            $kv = if ($kvByCtx.ContainsKey($_)) { $kvByCtx[$_] } else { @{ k = 'q8_0'; v = 'q8_0' } }
            @{ ctx = $_; kv_k = $kv.k; kv_v = $kv.v }
        })
    }

    $plan = @()
    $idx = 1
    $planningModelIndex = 0
    $planningModelTotal = @($catalog).Count
    foreach ($m in $catalog) {
        if ($Model -and $m.model -notmatch $Model) { continue }
        $planningModelIndex++
        Write-Host ("[planning] model {0}/{1}: {2} ({3})" -f `
            $planningModelIndex, $planningModelTotal, $m.model, $(if ($m.is_moe) { 'MoE' } else { 'dense' })) `
            -ForegroundColor Cyan
        $sweep = Get-SweepKind -meta $m -cfg $cfg
        $calibration = $null
        $calibrationId = ""
        $bnameLvl = [System.IO.Path]::GetFileName($m.path)
        $level = if ($bnameLvl -and $levelMap.ContainsKey($bnameLvl.ToLower())) { $levelMap[$bnameLvl.ToLower()] } else { $null }
        if ($Level -and $level -ne $Level) { continue }
        if (-not $m.is_moe -and -not $DryRun -and $supportsAdaptiveProbe) {
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
        } elseif ($m.is_moe -and -not $DryRun -and $supportsMoe -and $supportsAdaptiveProbe) {
            $moeSettings = $cfg.planning.moe_planning
            $probeCtx = if ($moeSettings.context_size) { [int]$moeSettings.context_size } else { 16384 }
            $requestedProbeKv = if ($moeSettings.kv_type) { [string]$moeSettings.kv_type } else { "q8_0" }
            $probeKv = Resolve-CompatibleKvType -Requested $requestedProbeKv -Allowed $llamaCapabilities.cacheTypesK
            $calibrationId = Get-MoeCalibrationId `
                -Meta $m -Config $cfg -BaseArgs $base -ContextSize $probeCtx -KvType $probeKv
            $calibration = Get-CachedOffloadCalibration `
                -CalibrationId $calibrationId -Config $cfg -Settings $moeSettings
            if (-not $calibration) {
                $calibration = Invoke-TsMoeCalibration -Meta $m -Config $cfg -BaseArgs $base
                if ($calibration) { $calibration.cache_hit = $false }
            }
            if ($calibration -and $calibration.calibrated) {
                if (-not $calibration.cache_hit) {
                    Save-OffloadCalibration `
                        -CalibrationId $calibrationId -Result $calibration -Meta $m -Config $cfg `
                        -BaseArgs $base -ContextSize $probeCtx -KvType $probeKv
                }
                $source = if ($calibration.cache_hit) { "cached" } else { "$($calibration.probe_count) probes" }
                Write-Host ("  adaptive MoE: {0}, load-fit anchor n-cpu-moe {1} ({2})" -f `
                    $m.model, $calibration.verified_n_cpu_moe, $source) -ForegroundColor DarkCyan
            } elseif ($calibration) {
                Write-Host ("  adaptive MoE fallback for {0}: {1}" -f $m.model, $calibration.reason) `
                    -ForegroundColor DarkYellow
            }
        } elseif ($m.is_moe -and -not $supportsMoe) {
            Write-Host ("  llama.cpp build does not expose --n-cpu-moe; keeping only the vanilla control for {0}" -f $m.model) -ForegroundColor DarkYellow
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

        $plan += (New-PlanItem `
            -meta $m -sweep $sweep -level $level -extraArgs "" `
            -label "vanilla_llama_cpp" -idx $idx -ControlKind "vanilla")
        $idx++

        switch ($sweep) {
            "context" {
                $skipped = 0
                $modelCandidates = @($ctxCandidates)
                if (-not $ctxOverride -and $perModelCap -gt 0 -and
                    (Test-CtxAllowedForModel -Ctx $perModelCap -GlobalCap $absoluteCtxCap -PerModelCap $perModelCap) -and
                    @($ctxCandidates | Where-Object { [int]$_.ctx -eq $perModelCap }).Count -eq 0) {
                    $next = @($ctxCandidates | Where-Object { [int]$_.ctx -gt $perModelCap } | Sort-Object { [int]$_.ctx } | Select-Object -First 1)
                    $fallback = @($ctxCandidates | Sort-Object { [int]$_.ctx } | Select-Object -Last 1)
                    $source = if ($next.Count -gt 0) { $next[0] } elseif ($fallback.Count -gt 0) { $fallback[0] } else { @{ kv = 'q8_0' } }
                    $kv = Get-CompatibleContextCandidateKv -Candidate $source -Capabilities $llamaCapabilities
                    $modelCandidates = @($ctxCandidates) + @(@{ ctx = $perModelCap; kv_k = $kv.k; kv_v = $kv.v; from_model_max = $true })
                    $modelCandidates = @($modelCandidates | Sort-Object { [int]$_.ctx })
                }
                $validCandidates = @()
                foreach ($c in $modelCandidates) {
                    $candidateGlobalCap = if ($c.from_model_max) { $absoluteCtxCap } else { $globalCtxCap }
                    if (-not (Test-CtxAllowedForModel -Ctx ([int]$c.ctx) -GlobalCap $candidateGlobalCap -PerModelCap $perModelCap)) {
                        $skipped++
                        continue
                    }
                    $validCandidates += $c
                    $kv = Get-CompatibleContextCandidateKv -Candidate $c -Capabilities $llamaCapabilities
                    $fitArg = if ($calibration -and $calibration.calibrated -and $supportsFit) { " --fit off" } else { "" }
                    $cacheArgs = if ($supportsCacheK -and $supportsCacheV) { " --cache-type-k $($kv.k) --cache-type-v $($kv.v)" } else { "" }
                    $argStr = "--ctx-size $($c.ctx) --gpu-layers 99$cacheArgs $base$fitArg"
                    $primary = New-PlanItem `
                        -meta $m -sweep $sweep -level $level -extraArgs $argStr `
                        -label "ctx=$($c.ctx)_$($kv.label)" -idx $idx `
                        -Calibration $calibration -CalibrationId $calibrationId
                    $plan += $primary
                    $idx++
                    $rescueSettings = $cfg.planning.kv_rescue
                    $rescueEnabled = (-not $rescueSettings -or $rescueSettings.enabled -ne $false)
                    $rescueMinCtx = if ($rescueSettings -and $rescueSettings.min_context_tokens) {
                        [int]$rescueSettings.min_context_tokens
                    } else { 65536 }
                    $requestedRescueK = if ($rescueSettings -and $rescueSettings.kv_k) { [string]$rescueSettings.kv_k } else { 'q4_0' }
                    $requestedRescueV = if ($rescueSettings -and $rescueSettings.kv_v) { [string]$rescueSettings.kv_v } else { 'q4_0' }
                    $rescueK = Resolve-CompatibleKvType -Requested $requestedRescueK -Allowed $llamaCapabilities.cacheTypesK
                    $rescueV = Resolve-CompatibleKvType -Requested $requestedRescueV -Allowed $llamaCapabilities.cacheTypesV
                    if ($rescueEnabled -and [int]$c.ctx -ge $rescueMinCtx -and
                        ($kv.k -ne $rescueK -or $kv.v -ne $rescueV)) {
                        $rescueCacheArgs = if ($supportsCacheK -and $supportsCacheV) { " --cache-type-k $rescueK --cache-type-v $rescueV" } else { "" }
                        $rescueArgs = "--ctx-size $($c.ctx) --gpu-layers 99$rescueCacheArgs $base$fitArg"
                        $rescueLabel = if ($rescueK -eq $rescueV) { "kv=$rescueK" } else { "kvk=${rescueK}_kvv=${rescueV}" }
                        $plan += (New-PlanItem `
                            -meta $m -sweep $sweep -level $level -extraArgs $rescueArgs `
                            -label "ctx=$($c.ctx)_${rescueLabel}_rescue" -idx $idx `
                            -Calibration $calibration -CalibrationId $calibrationId `
                            -ConditionalKind "kv_rescue" -ConditionalSourceId $primary.id)
                        $idx++
                    }
                }
                $anchor = @($validCandidates | Sort-Object { [int]$_.ctx } | Select-Object -Last 1)
                if ($anchor.Count -gt 0) {
                    $anchorCtx = [int]$anchor[0].ctx
                    $anchorKv = Get-CompatibleContextCandidateKv -Candidate $anchor[0] -Capabilities $llamaCapabilities
                    $plan += (New-PlanItem `
                        -meta $m -sweep $sweep -level $level `
                        -extraArgs "--ctx-size $anchorCtx" `
                        -label "llama_cpp_matched_ctx=${anchorCtx}_default" -idx $idx `
                        -ControlKind "vanilla-matched")
                    $idx++
                    $plan += (New-PlanItem `
                        -meta $m -sweep $sweep -level $level `
                        -extraArgs "--ctx-size $anchorCtx --parallel 1" `
                        -label "llama_cpp_matched_ctx=${anchorCtx}_parallel1" -idx $idx `
                        -ControlKind "vanilla-matched")
                    $idx++
                    if ($supportsCacheK -and $supportsCacheV) {
                        $plan += (New-PlanItem `
                            -meta $m -sweep $sweep -level $level `
                            -extraArgs "--ctx-size $anchorCtx --parallel 1 --cache-type-k $($anchorKv.k) --cache-type-v $($anchorKv.k)" `
                            -label "llama_cpp_matched_ctx=${anchorCtx}_parallel1_kv=$($anchorKv.k)" -idx $idx `
                            -ControlKind "vanilla-matched")
                        $idx++
                    }
                    $fitArg = if ($calibration -and $calibration.calibrated -and $supportsFit) { " --fit off" } else { "" }
                    $cacheArgs = if ($supportsCacheK -and $supportsCacheV) { " --cache-type-k $($anchorKv.k) --cache-type-v $($anchorKv.v)" } else { "" }
                    $argStr = "--ctx-size $anchorCtx --gpu-layers 99$cacheArgs $base$fitArg"
                    $profiles = @(Get-WorkloadProfilesForContext `
                        -ContextSize $anchorCtx `
                        -Config $cfg `
                        -Mode $PlanningPolicy.workload_sweep)
                    foreach ($profile in $profiles) {
                        $target = if ($profile.kind -eq "prefill") { $profile.prefill_tokens } else { $profile.kv_fill_tokens }
                        $label = "ctx=${anchorCtx}_$($anchorKv.label)"
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
                if (-not $supportsMoe) { break }
                $values = if ($calibration -and $calibration.calibrated) {
                    @($calibration.benchmark_n_cpu_moe | ForEach-Object { [int]$_ })
                } else {
                    @(Get-FallbackMoeCpuLayers)
                }
                $moeSettings = $cfg.planning.moe_planning
                $moeCtx = if ($moeSettings.context_size) { [int]$moeSettings.context_size } else { 16384 }
                $requestedMoeKv = if ($moeSettings.kv_type) { [string]$moeSettings.kv_type } else { "q8_0" }
                $moeKv = Resolve-CompatibleKvType -Requested $requestedMoeKv -Allowed $llamaCapabilities.cacheTypesK
                foreach ($n in $values) {
                    $fitArg = if ($calibration -and $calibration.calibrated -and $supportsFit) { " --fit off" } else { "" }
                    $cacheArgs = if ($supportsCacheK -and $supportsCacheV) { " --cache-type-k $moeKv --cache-type-v $moeKv" } else { "" }
                    $argStr = "--ctx-size $moeCtx --gpu-layers 99 --n-cpu-moe $n$cacheArgs $base$fitArg"
                    $fitOffset = if ($calibration -and $calibration.calibrated) {
                        [int]$n - [int]$calibration.verified_n_cpu_moe
                    } else { $null }
                    $plan += (New-PlanItem `
                        -meta $m -sweep $sweep -level $level -extraArgs $argStr `
                        -label "ncpumoe_$n" -idx $idx -Calibration $calibration `
                        -CalibrationId $calibrationId -FitOffset $fitOffset)
                    $idx++
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
                $requestedOffloadKv = if ($offloadSettings.kv_type) { [string]$offloadSettings.kv_type } else { "q8_0" }
                $offloadKv = Resolve-CompatibleKvType -Requested $requestedOffloadKv -Allowed $llamaCapabilities.cacheTypesK
                foreach ($n in $layers) {
                    $fitArg = if ($calibration -and $calibration.calibrated -and $supportsFit) { " --fit off" } else { "" }
                    $cacheArgs = if ($supportsCacheK -and $supportsCacheV) { " --cache-type-k $offloadKv --cache-type-v $offloadKv" } else { "" }
                    $argStr = "--ctx-size $offloadCtx --gpu-layers $n$cacheArgs $base$fitArg"
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


