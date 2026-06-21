# Narrow adapter for TypeScript-owned adaptive --n-cpu-moe calibration.

function Resolve-TsMoeCalibrationScript {
    if ($env:CALIBR_TS_MOE_CALIBRATION -eq '0') { return $null }
    foreach ($candidate in @(
        $env:CALIBR_TS_MOE_CALIBRATION_SCRIPT,
        (Join-Path $script:CALIBR_ROOT "cli\dist\moeCalibrationCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\moeCalibrationCli.js")
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-FallbackMoeCpuLayers {
    return @(28, 30, 32, 34, 36)
}

function Get-MoeCalibrationId {
    param($Meta, $Config, [string]$BaseArgs, [int]$ContextSize, [string]$KvType)
    $model = if ($Meta.path -and (Test-Path -LiteralPath $Meta.path)) { Get-Item -LiteralPath $Meta.path } else { $null }
    $llama = if ($Config.llama_server_exe -and (Test-Path -LiteralPath $Config.llama_server_exe)) {
        Get-Item -LiteralPath $Config.llama_server_exe
    } else { $null }
    $identity = @(
        'adaptive-moe-v1',
        [string]$Meta.path,
        $(if ($model) { [string]$model.Length } else { '' }),
        $(if ($model) { $model.LastWriteTimeUtc.ToString('o') } else { '' }),
        [string]$Config.llama_server_exe,
        $(if ($llama) { [string]$llama.Length } else { '' }),
        $(if ($llama) { $llama.LastWriteTimeUtc.ToString('o') } else { '' }),
        [string]$Config.hardware.gpu_name,
        [string]$Config.hardware.vram_total_mib,
        [string]$Config.hardware.vram_safety_budget_mib,
        $BaseArgs,
        [string]$ContextSize,
        $KvType,
        ($Config.planning.moe_planning | ConvertTo-Json -Compress -Depth 5)
    ) -join '|'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Invoke-TsMoeCalibration {
    param($Meta, $Config, [string]$BaseArgs)
    $script = Resolve-TsMoeCalibrationScript
    if (-not $script) { return $null }
    if (-not $Config.llama_server_exe -or -not (Test-Path -LiteralPath $Config.llama_server_exe)) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'llama-server unavailable' }
    }
    if (-not $Meta.gguf_expert_tensor_bytes -or -not $Meta.gguf_block_tensor_bytes) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'GGUF expert tensor metadata unavailable' }
    }
    $vramTotal = [double]$Config.hardware.vram_total_mib
    if ($vramTotal -le 0) {
        return @{ calibrated = $false; mode = 'fallback'; reason = 'detected VRAM unavailable' }
    }
    $safety = if ($Config.hardware.vram_safety_budget_mib) {
        [double]$Config.hardware.vram_safety_budget_mib / $vramTotal
    } else { [double]$Config.hardware.vram_safety_budget_pct }
    if ($safety -gt 1) { $safety /= 100 }
    if ($safety -le 0 -or $safety -gt 1) { $safety = 0.95 }
    $settings = $Config.planning.moe_planning
    $ctx = if ($settings.context_size) { [int]$settings.context_size } else { 16384 }
    $kv = if ($settings.kv_type) { [string]$settings.kv_type } else { 'q8_0' }
    $payload = @{
        executable = [string]$Config.llama_server_exe
        modelPath = [string]$Meta.path
        baseArgs = @(ConvertTo-OffloadArgumentList $BaseArgs)
        contextSize = $ctx
        kvType = $kv
        timeoutMs = $(if ($Config.bench.wait_sec_ready) { [int]$Config.bench.wait_sec_ready * 1000 } else { 120000 })
        vramTotalMib = $vramTotal
        safetyFraction = $safety
        metadata = @{
            size_mib = $Meta.size_mib
            gguf_block_count = $Meta.gguf_block_count
            gguf_tensor_bytes = $Meta.gguf_tensor_bytes
            gguf_global_tensor_bytes = $Meta.gguf_global_tensor_bytes
            gguf_block_tensor_bytes = @($Meta.gguf_block_tensor_bytes)
        }
        planning = @{
            runtimeReserveMib = $(if ($null -ne $settings.runtime_reserve_mib) { [int]$settings.runtime_reserve_mib } else { 512 })
            benchmarkOffsets = if ($settings.benchmark_offsets) {
                @($settings.benchmark_offsets | ForEach-Object { [int]$_ })
            } else { @(-3, -1, 0, 1, 3) }
            benchmarkRatios = if ($settings.benchmark_ratios) {
                @($settings.benchmark_ratios | ForEach-Object { [double]$_ })
            } else { @(0.5, 0.75) }
            tailOffsets = if ($settings.tail_offsets) {
                @($settings.tail_offsets | ForEach-Object { [int]$_ })
            } else { @(-3, -1, 0) }
            maxProbeCount = $(if ($settings.max_probe_count) { [int]$settings.max_probe_count } else { 4 })
            stableSampleCount = $(if ($settings.stable_sample_count) { [int]$settings.stable_sample_count } else { 3 })
            stableToleranceMib = $(if ($settings.stable_tolerance_mib) { [double]$settings.stable_tolerance_mib } else { 16 })
            maxReadySamples = $(if ($settings.max_ready_samples) { [int]$settings.max_ready_samples } else { 8 })
            sampleIntervalMs = $(if ($settings.sample_interval_ms) { [int]$settings.sample_interval_ms } else { 200 })
        }
    }
    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("moe-calibration-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        [System.IO.File]::WriteAllText($payloadPath, ($payload | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
        $output = @(& $node $script --json-file $payloadPath 2>$null)
        $json = $output | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1
        if (-not $json) { return @{ calibrated = $false; mode = 'fallback'; reason = "adapter returned no result (exit $LASTEXITCODE)" } }
        return ConvertTo-Hashtable -obj ($json | ConvertFrom-Json)
    } catch {
        return @{ calibrated = $false; mode = 'fallback'; reason = $_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}
