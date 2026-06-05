# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

function Find-LlamaServerExe {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $binName = "llama-server$script:ExeExt"   # 'llama-server.exe' on Windows, 'llama-server' elsewhere
    $onPath = Get-Command $binName -ErrorAction SilentlyContinue
    if ($onPath) { $candidates.Add($onPath.Path) }

    # Look in parent folders of ROOT up to 3 levels
    $p = $CALIBR_ROOT
    for ($i=0; $i -lt 3; $i++) {
        $p = Split-Path $p -Parent
        if (-not $p) { break }
        $found = @(Get-ChildItem $p -Filter $binName -Recurse -Depth 2 -ErrorAction SilentlyContinue)
        foreach ($f in $found) { $candidates.Add($f.FullName) }
    }
    return @($candidates | Select-Object -Unique | Where-Object { Test-Path $_ })
}

function Get-LlamaServerVersion {
    # Probe `llama-server --version` for the build tag (e.g. "b9360").
    # Falls back to extracting `bNNNN` from the binary path before returning
    # "unknown". Cheap one-off invocation (no model load); used by
    # Initialize-BenchSession to stamp the version on every result so the
    # report can group by llama.cpp build and the cache can re-run failures
    # that were recorded against a different version.
    param([string]$Exe)
    if (-not $Exe -or -not (Test-Path $Exe)) { return $null }
    try {
        $out = & $Exe --version 2>&1 | Out-String
        # Current llama-server (b9482+) prints "version: 9482 (4fb16eccc)" -
        # first number is the build, parenthesized is a commit hash we don't
        # want. Older builds occasionally printed "(b9460)" directly; match
        # both shapes, preferring the explicit bNNNN form.
        $m = [regex]::Match($out, '\((b\d+)\)')
        if ($m.Success) { return $m.Groups[1].Value }
        $m2 = [regex]::Match($out, 'version:\s*(\d+)\b')
        if ($m2.Success) { return 'b' + $m2.Groups[1].Value }
    } catch { }
    # Path-based fallback: the official zip names embed the build tag.
    $pm = [regex]::Match($Exe, '(b\d+)')
    if ($pm.Success) { return $pm.Groups[1].Value }
    return 'unknown'
}

function Initialize-BenchSession {
    # Set $script:BENCH_* and $script:LLAMA_SERVER_VERSION once per outer
    # command invocation. `all` calls Invoke-Bench in a loop (one per
    # sample); each inner call should share the same session, so this
    # helper is idempotent: a second call within the same process is a
    # no-op. The fields end up stamped on every result JSON so the report
    # can answer "show me only the results from THIS session" and "did
    # this model start working when I upgraded llama?".
    param([string]$LlamaServerExe)
    if ($script:BENCH_SESSION_ID) { return }
    $script:BENCH_SESSION_ID = [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $script:BENCH_SESSION_STARTED_AT = (Get-Date).ToUniversalTime().ToString('o')
    $script:LLAMA_SERVER_VERSION = Get-LlamaServerVersion -Exe $LlamaServerExe
    if (-not $script:LLAMA_SERVER_VERSION) { $script:LLAMA_SERVER_VERSION = 'unknown' }
}

# ============================================================================
# BACKEND DETECTION (CUDA / Vulkan / Metal / HIP / SYCL / CPU)
# ============================================================================
function Get-LlamaBackends {
    # Inspect ggml-*.dll siblings of llama-server.exe to learn which compute
    # backends the build supports. Cheap (single dir listing), no process probe.
    param([string]$exe)
    $backends = @{ cuda=$false; vulkan=$false; metal=$false; hip=$false; sycl=$false; cpu=$false }
    if (-not $exe -or -not (Test-Path $exe)) { return $backends }
    $dir = Split-Path $exe -Parent
    # Match ggml-cuda.dll (Windows) and libggml-cuda.so / ggml-cuda.so (Linux);
    # the leading '*' tolerates the 'lib' prefix Linux shared objects carry.
    $dlls = @(Get-ChildItem $dir -Filter "*ggml-*.$script:LibExt" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    foreach ($d in $dlls) {
        if ($d -match 'ggml-cuda')   { $backends.cuda   = $true }
        if ($d -match 'ggml-vulkan') { $backends.vulkan = $true }
        if ($d -match 'ggml-metal')  { $backends.metal  = $true }
        if ($d -match 'ggml-hip')    { $backends.hip    = $true }
        if ($d -match 'ggml-sycl')   { $backends.sycl   = $true }
        if ($d -match 'ggml-cpu')    { $backends.cpu    = $true }
    }
    return $backends
}

function Test-BackendHealthy {
    # Cross-check the detected GPU against the available llama.cpp backends.
    # Returns an array of warning strings (empty if optimal).
    param($cfg, $backends)
    $warnings = @()
    $gpu = $cfg.hardware.gpu_name
    if ($gpu -and $gpu -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Tesla') {
        if (-not $backends.cuda) {
            $msg = "NVIDIA GPU '$gpu' detected but llama.cpp build has NO CUDA backend. "
            if ($backends.vulkan) {
                $msg += "Vulkan will be used; expect ~10-15% slower inference. "
            } else {
                $msg += "Only CPU is available; inference will be very slow. "
            }
            $msg += "Get a CUDA build: https://github.com/ggml-org/llama.cpp/releases"
            $warnings += $msg
        }
    } elseif ($gpu -and $gpu -match 'AMD|Radeon') {
        if (-not ($backends.hip -or $backends.vulkan)) {
            $warnings += "AMD GPU '$gpu' detected but no HIP/Vulkan backend available; CPU only."
        }
    } elseif ($gpu -and $gpu -match 'Intel|Arc') {
        if (-not ($backends.sycl -or $backends.vulkan)) {
            $warnings += "Intel GPU '$gpu' detected but no SYCL/Vulkan backend available; CPU only."
        }
    } else {
        if (-not ($backends.cuda -or $backends.vulkan -or $backends.hip -or $backends.metal -or $backends.sycl)) {
            $warnings += "No GPU backend available in llama.cpp build; CPU only."
        }
    }
    return $warnings
}


