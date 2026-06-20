# TypeScript owns adaptive dense-model offload calibration. This module is
# the narrow PowerShell adapter used by the unified workflow; raw/headless
# runs retain an explicit conservative fallback when the adapter is absent.

function Resolve-TsOffloadCalibrationScript {
    if ($env:CALIBR_TS_OFFLOAD_CALIBRATION -eq '0') { return $null }
    foreach ($candidate in @(
        $env:CALIBR_TS_OFFLOAD_CALIBRATION_SCRIPT,
        (Join-Path $script:CALIBR_ROOT "cli\dist\offloadCalibrationCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\offloadCalibrationCli.js")
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function ConvertTo-OffloadArgumentList {
    param([string]$Value)
    if (-not $Value) { return @() }
    return @([regex]::Matches($Value, '(?:"[^"]*"|''[^'']*''|\S+)') | ForEach-Object {
        $token = $_.Value
        if ($token.Length -ge 2 -and
            (($token.StartsWith('"') -and $token.EndsWith('"')) -or
             ($token.StartsWith("'") -and $token.EndsWith("'")))) {
            $token.Substring(1, $token.Length - 2)
        } else {
            $token
        }
    })
}

function Get-FallbackSweepKind {
    param($Meta, $Config)
    if ($Meta.is_moe) { return 'moe-cpu' }
    $budget = [int]$Config.hardware.vram_safety_budget_mib
    $mmprojMib = if ($Meta.mmproj -and (Test-Path -LiteralPath $Meta.mmproj)) {
        [math]::Ceiling((Get-Item -LiteralPath $Meta.mmproj).Length / 1MB)
    } else { 0 }
    if (($Meta.size_mib + $mmprojMib + 1200) -lt $budget) { return 'context' }
    return 'offload'
}

function Get-FallbackOffloadLayers {
    return @(20, 24, 28, 32, 36)
}

function Get-OffloadCalibrationId {
    param($Meta, $Config, [string]$BaseArgs, [int]$ContextSize, [string]$KvType)
    $model = if ($Meta.path -and (Test-Path -LiteralPath $Meta.path)) {
        Get-Item -LiteralPath $Meta.path
    } else { $null }
    $identity = @(
        [string]$Meta.path,
        $(if ($model) { [string]$model.Length } else { '' }),
        $(if ($model) { $model.LastWriteTimeUtc.ToString('o') } else { '' }),
        [string]$Config.llama_server_exe,
        [string]$Config.hardware.gpu_name,
        [string]$Config.hardware.vram_total_mib,
        [string]$Config.hardware.vram_safety_budget_mib,
        [string]$Meta.mmproj,
        $BaseArgs,
        [string]$ContextSize,
        $KvType
    ) -join '|'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($identity)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Save-OffloadCalibration {
    param(
        [string]$CalibrationId,
        $Result,
        $Meta,
        $Config,
        [string]$BaseArgs,
        [int]$ContextSize,
        [string]$KvType
    )
    if (-not $CalibrationId -or -not $Result) { return }
    $record = [ordered]@{
        schema_version = 1
        calibration_id = $CalibrationId
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        model_path = $Meta.path
        model_size_mib = $Meta.size_mib
        llama_server_exe = $Config.llama_server_exe
        gpu_name = $Config.hardware.gpu_name
        vram_total_mib = $Config.hardware.vram_total_mib
        vram_safety_budget_mib = $Config.hardware.vram_safety_budget_mib
        context_size = $ContextSize
        kv_type = $KvType
        base_args = $BaseArgs
        result = $Result
    }
    $path = Join-Path $script:CALIBR_CALIBRATIONS_DIR "$CalibrationId.json"
    [System.IO.File]::WriteAllText(
        $path,
        ($record | ConvertTo-Json -Depth 15),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Invoke-TsOffloadCalibration {
    param($Meta, $Config, [string]$BaseArgs)

    if ($Meta.is_moe) { return $null }
    $script = Resolve-TsOffloadCalibrationScript
    if (-not $script) { return $null }
    if (-not $Config.llama_server_exe -or -not (Test-Path -LiteralPath $Config.llama_server_exe)) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'llama-server unavailable' }
    }
    if (-not $Meta.gguf_block_count) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'GGUF block metadata unavailable' }
    }

    $vramTotal = [double]$Config.hardware.vram_total_mib
    if ($vramTotal -le 0) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'detected VRAM unavailable' }
    }
    $safety = if ($Config.hardware.vram_safety_budget_mib) {
        [double]$Config.hardware.vram_safety_budget_mib / $vramTotal
    } else {
        [double]$Config.hardware.vram_safety_budget_pct
    }
    if ($safety -gt 1) { $safety /= 100 }
    if ($safety -le 0 -or $safety -gt 1) { $safety = 0.95 }

    $settings = $Config.planning.offload_planning
    $ctx = if ($settings.context_size) { [int]$settings.context_size } else { 16384 }
    $kv = if ($settings.kv_type) { [string]$settings.kv_type } else { 'q8_0' }
    $mmprojMib = if ($Meta.mmproj -and (Test-Path -LiteralPath $Meta.mmproj)) {
        [math]::Ceiling((Get-Item -LiteralPath $Meta.mmproj).Length / 1MB)
    } else { 0 }
    $payload = @{
        executable = [string]$Config.llama_server_exe
        modelPath = [string]$Meta.path
        mmprojPath = if ($Meta.mmproj) { [string]$Meta.mmproj } else { $null }
        mmprojMib = $mmprojMib
        baseArgs = @(ConvertTo-OffloadArgumentList $BaseArgs)
        contextSize = $ctx
        kvType = $kv
        timeoutMs = $(if ($Config.bench.wait_sec_ready) { [int]$Config.bench.wait_sec_ready * 1000 } else { 120000 })
        vramTotalMib = $vramTotal
        safetyFraction = $safety
        sharedConfirmMib = $(if ($Config.wddm_detection.shared_delta_confirm_mib) { [int]$Config.wddm_detection.shared_delta_confirm_mib } else { 500 })
        metadata = @{
            size_mib = $Meta.size_mib
            gguf_block_count = $Meta.gguf_block_count
            gguf_tensor_bytes = $Meta.gguf_tensor_bytes
            gguf_global_tensor_bytes = $Meta.gguf_global_tensor_bytes
            gguf_expert_tensor_bytes = $Meta.gguf_expert_tensor_bytes
            gguf_block_tensor_bytes = @($Meta.gguf_block_tensor_bytes)
        }
        planning = @{
            runtimeReserveMib = $(if ($null -ne $settings.runtime_reserve_mib) { [int]$settings.runtime_reserve_mib } else { 512 })
            benchmarkOffsets = @($settings.benchmark_offsets | ForEach-Object { [int]$_ })
            maxProbeCount = $(if ($settings.max_probe_count) { [int]$settings.max_probe_count } else { 4 })
            stableSampleCount = $(if ($settings.stable_sample_count) { [int]$settings.stable_sample_count } else { 3 })
            stableToleranceMib = $(if ($settings.stable_tolerance_mib) { [double]$settings.stable_tolerance_mib } else { 16 })
            maxReadySamples = $(if ($settings.max_ready_samples) { [int]$settings.max_ready_samples } else { 8 })
            sampleIntervalMs = $(if ($settings.sample_interval_ms) { [int]$settings.sample_interval_ms } else { 200 })
        }
    }

    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("offload-calibration-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        [System.IO.File]::WriteAllText(
            $payloadPath,
            ($payload | ConvertTo-Json -Depth 12),
            (New-Object System.Text.UTF8Encoding($false))
        )
        $output = @(& $node $script --json-file $payloadPath 2>$null)
        $json = $output | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1
        if (-not $json) {
            return @{ calibrated = $false; mode = 'fallback'; reason = "adapter returned no result (exit $LASTEXITCODE)" }
        }
        return ConvertTo-Hashtable -obj ($json | ConvertFrom-Json)
    } catch {
        return @{ calibrated = $false; mode = 'fallback'; reason = $_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}
