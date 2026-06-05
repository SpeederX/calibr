# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: plan
# ============================================================================
function Get-SweepKind {
    # Which dimension the plan sweeps for a model, from its own properties:
    #   moe-cpu : mixture-of-experts -> sweep --n-cpu-moe (how many expert
    #             layers stay on CPU)
    #   context : fits the VRAM budget -> sweep context size + KV-cache quant
    #   offload : too big for one GPU -> sweep --gpu-layers (how much offloads)
    # (Formerly the A/B/C "tier"; renamed to say what it MEANS, not a letter.)
    param($meta, $cfg)
    if ($meta.is_moe) { return "moe-cpu" }
    $budget = [int]$cfg.hardware.vram_safety_budget_mib
    $overhead = [int]$cfg.planning.overhead_mib
    $mmprojMib = if ($meta.mmproj) { [int]((Get-Item $meta.mmproj).Length / 1MB) } else { 0 }
    $needed = $meta.size_mib + $mmprojMib + $overhead
    if ($needed -lt $budget) { return "context" }
    return "offload"
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

function New-PlanItem {
    param($meta, $sweep, $level, $extraArgs, $label, $idx)
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
    $sanitizedLabel = $label -replace '[^\w]', '_'
    if ($sanitizedModel.Length -gt 40) { $sanitizedModel = $sanitizedModel.Substring(0, 40) }
    if ($sanitizedLabel.Length -gt 30) { $sanitizedLabel = $sanitizedLabel.Substring(0, 30) }
    $id = "{0}__{1}" -f $sanitizedModel, $sanitizedLabel
    return @{
        id          = $id
        model_path  = $meta.path
        mmproj_path = $meta.mmproj
        model       = $meta.model
        variant     = $meta.variant
        series      = $meta.series
        sweep       = $sweep
        level       = $level
        label       = "$($meta.model) $($meta.variant) @ $label"
        extra_args  = $extraArgs
    }
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
    # If 'all -Preset' set a preset-level ctx ceiling, apply the MORE
    # restrictive of (preset, config) as the effective global cap. This
    # is how presets like 'low' (max_ctx 32k) actually narrow the context
    # sweep without needing a per-call -MaxCtx flag.
    if ($script:_presetMaxCtx -and [int]$script:_presetMaxCtx -gt 0) {
        $presetCap = [int]$script:_presetMaxCtx
        if ($globalCtxCap -eq 0 -or $presetCap -lt $globalCtxCap) {
            $globalCtxCap = $presetCap
        }
    }
    $perModelCaps = Get-CatalogMaxContextMap
    $levelMap = Get-CatalogLevelMap

    $plan = @()
    $idx = 1
    foreach ($m in $catalog) {
        if ($Model -and $m.model -notmatch $Model) { continue }
        $sweep = Get-SweepKind -meta $m -cfg $cfg
        $bnameLvl = [System.IO.Path]::GetFileName($m.path)
        $level = if ($bnameLvl -and $levelMap.ContainsKey($bnameLvl.ToLower())) { $levelMap[$bnameLvl.ToLower()] } else { $null }
        if ($Level -and $level -ne $Level) { continue }

        # Per-model ctx cap if the .gguf basename matches a curated sample.
        # User-owned files won't match -> $perModelCap stays 0 -> only the
        # global cap applies.
        $perModelCap = 0
        $bname = [System.IO.Path]::GetFileName($m.path)
        if ($bname -and $perModelCaps.ContainsKey($bname.ToLower())) {
            $perModelCap = $perModelCaps[$bname.ToLower()]
        }

        switch ($sweep) {
            "context" {
                $skipped = 0
                foreach ($c in $cfg.context_candidates) {
                    if (-not (Test-CtxAllowedForModel -Ctx ([int]$c.ctx) -GlobalCap $globalCtxCap -PerModelCap $perModelCap)) {
                        $skipped++
                        continue
                    }
                    $argStr = "--ctx-size $($c.ctx) --gpu-layers 99 --cache-type-k $($c.kv) --cache-type-v $($c.kv) $base"
                    $plan += (New-PlanItem -meta $m -sweep $sweep -level $level -extraArgs $argStr -label "ctx=$($c.ctx)_kv=$($c.kv)" -idx $idx); $idx++
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
                foreach ($n in $cfg.planning.offload_sweep) {
                    $argStr = "--ctx-size 16384 --gpu-layers $n --cache-type-k q8_0 --cache-type-v q8_0 $base"
                    $plan += (New-PlanItem -meta $m -sweep $sweep -level $level -extraArgs $argStr -label "ngl_$n" -idx $idx); $idx++
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


