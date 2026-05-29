#Requires -Version 5.1
<#
.SYNOPSIS
    calibr -- crawler/tester for GGUF models via llama.cpp

.DESCRIPTION
    Discovers GGUF models in configured paths, classifies each by tier based on
    a VRAM safety budget, generates and runs a benchmark plan with WDDM-paging
    detection on Windows, and emits an HTML report plus per-model .bat launchers.

.EXAMPLE
    calibr init                     # first-time setup: detect HW, write config.json
    calibr discover                 # scan for .gguf files
    calibr plan                     # generate test plan
    calibr bench -Tier A            # run only Tier A benchmarks
    calibr bench -Model Qwen3.5-9B  # run only this model
    calibr report                   # build HTML + .bat
    calibr all                      # full pipeline (works on whatever .gguf are on disk)
    calibr all -DownloadSamples     # fetch curated samples first, then run the pipeline
    calibr all -DownloadSamples -SampleId qwen3.5-9b-q4km   # only one sample (~5 GB)

    # One-shot without editing config.json (useful for CI / try-and-throw-away):
    calibr discover -ScanPath "D:\models","E:\llm-cache"
    calibr all -ScanPath "C:\foo" -LlamaServer "C:\bin\llama-server.exe"

.NOTES
    Project: https://github.com/<OWNER>/calibr  (update after publishing)
#>

[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet("init","discover","plan","bench","report","all","status","help","get-sample-models","config","install","uninstall","")]
    [string]$Command = "help",

    # Sub-action / target name. Meaning depends on $Command:
    #   help <name>      -> command to describe
    #   config <action>  -> list | get | set | unset
    [Parameter(Position=1)]
    [string]$Action = "",

    # Dot-notation key path for `config get/set/unset`, e.g. "hardware.vram_total_mib"
    [Parameter(Position=2)]
    [string]$Key = "",

    # Value string for `config set` (CSV for arrays). Type is inferred from the default schema.
    [Parameter(Position=3)]
    [string]$Value = "",

    [string]$Config = "",
    [string]$Model = "",
    [ValidateSet("", "A", "B", "C")][string]$Tier = "",
    [string]$Id = "",
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NonInteractive,

    # CLI overrides for config fields. These take priority over config.json.
    # Used by: discover (ScanPath, ExcludePattern), bench/report (LlamaServer), all (all of them), init (pre-fills instead of auto-detecting).
    [string[]]$ScanPath = @(),
    [string]$LlamaServer = "",
    [string[]]$ExcludePattern = @(),

    # Used by get-sample-models
    [string]$SampleId = "",          # download only the matching sample id
    [switch]$DownloadAll,            # download all samples (prompts for confirmation)
    [switch]$DownloadSamples,        # `all` only: fetch curated samples before running the pipeline
    [string]$Destination = "",       # override target root (default: scan_paths[0])

    # Used by report: how to group results when selecting winners
    [ValidateSet("model", "model+variant")]
    [string]$GroupBy = "model",

    # Used by report (and `all`): pick the highest-eval_tps config per group,
    # ignoring WDDM-paging safety. Default off — safety wins ties.
    [switch]$PreferSpeed,

    # Used by bench (and `all`): how many runs to execute per config when
    # gathering measurements. The top-level result records the median over the
    # N runs for varying metrics; raw per-run values live in a `runs` array.
    # 0 means "use bench.runs_per_config from config" (default 3).
    [int]$Runs = 0,

    # Used by bench (and `all`): opt out of post-bench rotation. By default,
    # when a model's .gguf was downloaded by calibr (recorded in the download
    # manifest at data/downloads.json) and every config for that model
    # finished successfully, the .gguf and its auto-paired mmproj are deleted
    # to keep peak working-set bounded to one model. -KeepDownloads disables
    # the cleanup so files survive the bench. User-owned files (those not in
    # the manifest) are never touched regardless of this flag.
    [switch]$KeepDownloads
)

$ErrorActionPreference = "Stop"

# ============================================================================
# PATHS
# ============================================================================
$script:CALIBR_ROOT = $PSScriptRoot
$script:CALIBR_DEFAULT_CFG = Join-Path $CALIBR_ROOT "config.default.json"
$script:CALIBR_LOCAL_CFG   = if ($Config) { $Config } else { Join-Path $CALIBR_ROOT "config.json" }
$script:CALIBR_DATA_DIR    = if ($env:CALIBR_DATA_DIR) { $env:CALIBR_DATA_DIR } else { Join-Path $CALIBR_ROOT "data" }
$script:CALIBR_CATALOG     = Join-Path $CALIBR_DATA_DIR "catalog.json"
$script:CALIBR_PLAN        = Join-Path $CALIBR_DATA_DIR "plan.json"
$script:CALIBR_RESULTS_DIR = Join-Path $CALIBR_DATA_DIR "results"
$script:CALIBR_LOGS_DIR    = Join-Path $CALIBR_DATA_DIR "logs"
$script:CALIBR_BATS_DIR    = Join-Path $CALIBR_DATA_DIR "bats"
$script:CALIBR_REPORT      = Join-Path $CALIBR_DATA_DIR "report.html"
$script:CALIBR_DOWNLOADS   = Join-Path $CALIBR_DATA_DIR "downloads.json"

foreach ($d in @($CALIBR_DATA_DIR, $CALIBR_RESULTS_DIR, $CALIBR_LOGS_DIR, $CALIBR_BATS_DIR)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ============================================================================
# CONFIG LOADING (default <- local override, deep merge)
# ============================================================================
function Merge-Hashtables {
    param($base, $over)
    if ($null -eq $over) { return $base }
    foreach ($k in $over.Keys) {
        if ($base.ContainsKey($k) -and $base[$k] -is [hashtable] -and $over[$k] -is [hashtable]) {
            $base[$k] = Merge-Hashtables $base[$k] $over[$k]
        } else {
            $base[$k] = $over[$k]
        }
    }
    return $base
}

function ConvertTo-Hashtable {
    param($obj)
    if ($null -eq $obj) { return $null }
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $obj.PSObject.Properties) {
            $h[$p.Name] = ConvertTo-Hashtable $p.Value
        }
        return $h
    }
    if ($obj -is [array]) {
        # The leading comma prevents PowerShell from unwrapping single-element
        # arrays, which would turn ["path"] into the string "path" and break
        # any subsequent [0] index.
        $arr = @($obj | ForEach-Object { ConvertTo-Hashtable $_ })
        return ,$arr
    }
    return $obj
}

function Get-Config {
    if (-not (Test-Path $CALIBR_DEFAULT_CFG)) { throw "Missing config.default.json at $CALIBR_DEFAULT_CFG" }
    $defRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $default = ConvertTo-Hashtable -obj $defRaw
    if (Test-Path $CALIBR_LOCAL_CFG) {
        $locRaw = Get-Content $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
        $local = ConvertTo-Hashtable -obj $locRaw
        $default = Merge-Hashtables $default $local
    }
    # Strip _comment_* keys for cleanliness
    $result = @{}
    foreach ($k in $default.Keys) {
        if ($k -notmatch '^_comment') { $result[$k] = $default[$k] }
    }

    # Apply CLI overrides (highest priority, never persisted to disk)
    if ($script:ScanPath -and $script:ScanPath.Count -gt 0) {
        $result.scan_paths = @($script:ScanPath)
    }
    if ($script:LlamaServer) {
        $result.llama_server_exe = $script:LlamaServer
    }
    if ($script:ExcludePattern -and $script:ExcludePattern.Count -gt 0) {
        $existing = if ($result.exclude_patterns) { @($result.exclude_patterns) } else { @() }
        $result.exclude_patterns = @($existing + $script:ExcludePattern)
    }

    # Auto-detect hardware in-memory if the user hasn't supplied it via config.json.
    # This makes the tool usable end-to-end with just CLI flags, no init / config.json required.
    if ($result.hardware -and -not $result.hardware.vram_total_mib -and $result.hardware.auto_detect) {
        $detected = Get-DetectedHardware
        if ($detected.vram_total_mib) {
            $result.hardware.vram_total_mib = $detected.vram_total_mib
            $pct = if ($result.hardware.vram_safety_budget_pct) { $result.hardware.vram_safety_budget_pct } else { 0.95 }
            $result.hardware.vram_safety_budget_mib = [int]($detected.vram_total_mib * $pct)
            $result.hardware.gpu_name           = $detected.gpu_name
            $result.hardware.gpu_compute_cap    = $detected.gpu_compute_cap
            $result.hardware.cpu_cores_physical = $detected.cpu_cores_physical
            $result.hardware.cpu_threads_logical= $detected.cpu_threads_logical
        }
    }

    return $result
}

# ============================================================================
# HARDWARE DETECTION (for `init`)
# ============================================================================
function Get-DetectedHardware {
    $hw = @{
        vram_total_mib       = $null
        gpu_name             = $null
        gpu_compute_cap      = $null
        cpu_cores_physical   = $null
        cpu_threads_logical  = $null
    }
    try {
        $gpu = (nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        if ($gpu) {
            $parts = $gpu -split ',\s*'
            $hw.gpu_name        = $parts[0].Trim()
            $hw.vram_total_mib  = [int]$parts[1].Trim()
            $hw.gpu_compute_cap = $parts[2].Trim()
        }
    } catch { }
    try {
        $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cpu) {
            $hw.cpu_cores_physical  = [int]$cpu.NumberOfCores
            $hw.cpu_threads_logical = [int]$cpu.NumberOfLogicalProcessors
        }
    } catch { }
    return $hw
}

function Find-LlamaServerExe {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $onPath = Get-Command llama-server.exe -ErrorAction SilentlyContinue
    if ($onPath) { $candidates.Add($onPath.Path) }

    # Look in parent folders of ROOT up to 3 levels
    $p = $CALIBR_ROOT
    for ($i=0; $i -lt 3; $i++) {
        $p = Split-Path $p -Parent
        if (-not $p) { break }
        $found = @(Get-ChildItem $p -Filter "llama-server.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue)
        foreach ($f in $found) { $candidates.Add($f.FullName) }
    }
    return @($candidates | Select-Object -Unique | Where-Object { Test-Path $_ })
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
    $dlls = @(Get-ChildItem $dir -Filter "ggml-*.dll" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
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

function Find-ModelRoots {
    # Suggest scan_paths: parent of ROOT, sibling folders that look like model storage
    $p = Split-Path $CALIBR_ROOT -Parent
    $parent = Split-Path $p -Parent
    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($parent -and (Test-Path $parent)) {
        # look for folders containing any .gguf
        Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $gg = Get-ChildItem $_.FullName -Filter "*.gguf" -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($gg) { $candidates.Add($_.FullName) }
        }
        # if any gguf directly in parent
        if (Get-ChildItem $parent -Filter "*.gguf" -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1) {
            $candidates.Add($parent)
        }
    }
    return @($candidates | Select-Object -Unique)
}

# ============================================================================
# SUBCOMMAND: init
# ============================================================================
function Invoke-Init {
    Write-Host "=== calibr init ===" -ForegroundColor Cyan

    $cfgRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $cfg = ConvertTo-Hashtable -obj $cfgRaw
    $override = @{}

    Write-Host "Detecting hardware..."
    $hw = Get-DetectedHardware
    if ($hw.gpu_name) {
        Write-Host "  GPU: $($hw.gpu_name), $($hw.vram_total_mib) MiB VRAM, compute $($hw.gpu_compute_cap)" -ForegroundColor Green
    } else {
        Write-Warning "  nvidia-smi not available or no NVIDIA GPU detected. You'll need to set vram_total_mib manually."
    }
    if ($hw.cpu_cores_physical) {
        Write-Host "  CPU: $($hw.cpu_cores_physical)C/$($hw.cpu_threads_logical)T" -ForegroundColor Green
    }

    if ($hw.vram_total_mib) {
        $budget = [int]($hw.vram_total_mib * $cfg.hardware.vram_safety_budget_pct)
        Write-Host "  VRAM safety budget: $budget MiB ($(($cfg.hardware.vram_safety_budget_pct * 100).ToString('F0'))% of total)"
    }

    $override.hardware = @{
        vram_total_mib         = $hw.vram_total_mib
        vram_safety_budget_mib = if ($hw.vram_total_mib) { [int]($hw.vram_total_mib * $cfg.hardware.vram_safety_budget_pct) } else { $null }
        gpu_name               = $hw.gpu_name
        gpu_compute_cap        = $hw.gpu_compute_cap
        cpu_cores_physical     = $hw.cpu_cores_physical
        cpu_threads_logical    = $hw.cpu_threads_logical
    }

    if ($LlamaServer) {
        Write-Host "`nUsing -LlamaServer override: $LlamaServer" -ForegroundColor Cyan
        $override.llama_server_exe = $LlamaServer
    } else {
        Write-Host "`nSearching for llama-server.exe..."
        $exes = Find-LlamaServerExe
        if ($exes.Count -eq 0) {
            Write-Warning "  Not found. Edit config.json and set llama_server_exe manually."
            $override.llama_server_exe = $null
        } elseif ($exes.Count -eq 1) {
            Write-Host "  Found: $($exes[0])" -ForegroundColor Green
            $override.llama_server_exe = $exes[0]
        } else {
            Write-Host "  Multiple candidates:" -ForegroundColor Yellow
            for ($i=0; $i -lt $exes.Count; $i++) { Write-Host "    [$i] $($exes[$i])" }
            if ($NonInteractive) {
                $override.llama_server_exe = $exes[0]
                Write-Host "  Picked [0] (non-interactive). Re-run with -LlamaServer to pick a specific one."
            } else {
                $idx = Read-Host "  Pick index [0]"
                if (-not $idx) { $idx = 0 }
                $override.llama_server_exe = $exes[[int]$idx]
            }
        }
    }

    if ($ScanPath -and $ScanPath.Count -gt 0) {
        Write-Host "`nUsing -ScanPath override: $($ScanPath -join ', ')" -ForegroundColor Cyan
        $override.scan_paths = @($ScanPath)
    } else {
        Write-Host "`nSearching for .gguf folders..."
        $roots = Find-ModelRoots
        if ($roots.Count -eq 0) {
            Write-Warning "  No folders with .gguf files found near this script."
            if (-not $NonInteractive) {
                $manual = Read-Host "  Enter scan path (or empty to skip)"
                if ($manual) { $override.scan_paths = @($manual) } else { $override.scan_paths = @() }
            } else {
                $override.scan_paths = @()
            }
        } else {
            Write-Host "  Found $($roots.Count) candidate root(s):" -ForegroundColor Green
            $roots | ForEach-Object { Write-Host "    $_" }
            $override.scan_paths = $roots
        }
    }

    # Write config.json
    $out = [ordered]@{}
    if ($override.llama_server_exe) { $out.llama_server_exe = $override.llama_server_exe }
    if ($override.scan_paths)       { $out.scan_paths = $override.scan_paths }
    $out.hardware = @{
        auto_detect            = $false
        vram_total_mib         = $override.hardware.vram_total_mib
        vram_safety_budget_mib = $override.hardware.vram_safety_budget_mib
        gpu_name               = $override.hardware.gpu_name
        gpu_compute_cap        = $override.hardware.gpu_compute_cap
        cpu_cores_physical     = $override.hardware.cpu_cores_physical
        cpu_threads_logical    = $override.hardware.cpu_threads_logical
    }

    if ((Test-Path $CALIBR_LOCAL_CFG) -and (-not $Force)) {
        Write-Warning "`n$CALIBR_LOCAL_CFG already exists. Use -Force to overwrite."
        return
    }
    $out | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
    Write-Host "`nWrote $CALIBR_LOCAL_CFG" -ForegroundColor Green
    Write-Host "Next: calibr discover" -ForegroundColor Cyan
}

# ============================================================================
# SUBCOMMAND: discover
# ============================================================================
function Get-ModelMetadata {
    param([string]$path)
    $file = Get-Item -LiteralPath $path
    $fname = $file.BaseName

    $variant = "unknown"
    $model   = $fname
    $variantPatterns = @(
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_XL)$',
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_M)$',
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_S)$',
        '^(?<m>.+?)[\.\-](?<v>Q\d+_K_[A-Z]+)$',
        '^(?<m>.+?)[\.\-](?<v>Q\d+_\d+)$',
        '^(?<m>.+?)[\.\-](?<v>IQ\d+_[A-Z_]+)$',
        '^(?<m>.+?)[\.\-](?<v>BF16|F16|F32)$'
    )
    foreach ($p in $variantPatterns) {
        if ($fname -match $p) { $model = $Matches.m; $variant = $Matches.v; break }
    }

    # Series: parsed from model. Strip the trailing size+suffix token group
    # (e.g. "Qwen3.5-9B" -> "Qwen3.5", "Gemma-4-E2B-it" -> "Gemma-4",
    # "Qwen3.6-35B-A3B" -> "Qwen3.6"). Falls back to the model itself if
    # nothing matches.
    $series = $model
    if ($model -match '^(.+?)-[A-Z]?\d+(\.\d+)?B(-A\d+B)?(-it|-Instruct)?$') {
        $series = $Matches[1]
    }

    # MoE heuristics: -A\d+B (active params) or explicit MoE/Mixtral
    $is_moe = ($model -match 'A\d+B' -or $model -match 'MoE' -or $model -match 'Mixtral')

    # Param count in billions (best-effort)
    $params_b = 0
    if ($model -match '(\d+\.?\d*)B') { $params_b = [double]$Matches[1] }

    # Sibling mmproj (prefer F16 < BF16 < F32)
    $mmproj = $null
    $mmCand = Get-ChildItem $file.Directory.FullName -Filter "mmproj-*.gguf" -ErrorAction SilentlyContinue
    if ($mmCand) {
        $pref = $mmCand | Sort-Object {
            switch -Regex ($_.Name) { 'F16'{0}; 'BF16'{1}; 'F32'{2}; default{3} }
        } | Select-Object -First 1
        $mmproj = $pref.FullName
    }

    return @{
        role       = "model"
        path       = $file.FullName
        name       = $file.Name
        size_bytes = $file.Length
        size_mib   = [int]($file.Length / 1MB)
        model      = $model
        series     = $series
        variant    = $variant
        params_b   = $params_b
        is_moe     = $is_moe
        mmproj     = $mmproj
        dir        = $file.Directory.FullName
    }
}

function Invoke-DenseOverrideFilter {
    # Post-hoc filter: clear is_moe if the model is on the user's
    # dense_overrides list. The MoE regex inside Get-ModelMetadata stays
    # untouched (real MoE families are still detected by default); the
    # override is a small, exact-match escape hatch for false positives.
    # Pure: mutates and returns $meta but has no side effects.
    param($meta, $denseOverrides)
    if ($null -eq $meta) { return $meta }
    if ($null -eq $denseOverrides) { return $meta }
    $list = @($denseOverrides)
    # -ccontains keeps the comparison case-sensitive (per spec). -contains
    # in PowerShell is case-insensitive by default; we do not want
    # `qwen3.6-35b-a3b` to silently match `Qwen3.6-35B-A3B` and disable MoE.
    if ($meta.is_moe -and ($list -ccontains $meta.model)) {
        $meta.is_moe = $false
    }
    return $meta
}

function Invoke-Discover {
    $cfg = Get-Config
    Write-Host "=== discover ===" -ForegroundColor Cyan
    if (-not $cfg.scan_paths -or $cfg.scan_paths.Count -eq 0) {
        throw "scan_paths is empty. Run 'calibr init' or edit config.json."
    }

    $catalog = @()
    foreach ($base in $cfg.scan_paths) {
        if (-not (Test-Path $base)) { Write-Warning "scan path not found: $base"; continue }
        $abs = (Resolve-Path -LiteralPath $base -ErrorAction SilentlyContinue).Path
        $display = if ($abs -and $abs -ne $base) { "$base  ->  $abs" } else { $base }
        Write-Host "Scanning $display"
        if ($base -eq "." -or $base -eq ".\") {
            Write-Host "  (relative path; resolves against the current working directory)" -ForegroundColor DarkYellow
        }
        $ggufs = Get-ChildItem -LiteralPath $base -Filter "*.gguf" -Recurse -File -ErrorAction SilentlyContinue
        foreach ($f in $ggufs) {
            $skip = $false
            foreach ($ex in $cfg.exclude_patterns) {
                if ($f.Name -like $ex) { $skip = $true; break }
            }
            if ($skip) { continue }
            $meta = Get-ModelMetadata $f.FullName
            $meta = Invoke-DenseOverrideFilter -meta $meta -denseOverrides $cfg.dense_overrides
            $catalog += $meta
            Write-Host ("  {0,-50} {1,8} MiB  [{2}] {3}" -f $meta.model, $meta.size_mib, $meta.variant, $(if($meta.is_moe){'MoE'}else{'dense'})) -ForegroundColor Gray
        }
    }

    $catalog | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $CALIBR_CATALOG
    Write-Host ("Catalog: {0} models -> {1}" -f $catalog.Count, $CALIBR_CATALOG) -ForegroundColor Green

    # Surface the case where a single mmproj file on disk is paired with
    # multiple distinct text models (historical Gemma 4 E2B vs E4B clash,
    # different vision n_embd but same filename). The detection logic itself
    # lives in Find-MmprojSharedAcrossModels so it can be unit-tested without
    # a real filesystem walk; this loop just renders the warnings.
    foreach ($warn in (Find-MmprojSharedAcrossModels -catalog $catalog)) {
        Write-Host ""
        Write-Host ("WARNING: mmproj shared across {0} distinct models:" -f $warn.models.Count) -ForegroundColor Yellow
        Write-Host ("  mmproj: {0}" -f $warn.mmproj) -ForegroundColor Yellow
        Write-Host ("  models: {0}" -f ($warn.models -join ', ')) -ForegroundColor Yellow
        Write-Host  "  If these models have different vision n_embd, bench will fail at load." -ForegroundColor Yellow
        Write-Host  "  Workaround: move each variant into its own subfolder so the mmproj files do not collide." -ForegroundColor Yellow
    }
}

function Find-MmprojSharedAcrossModels {
    # Pure: groups catalog entries by their paired mmproj path; returns an
    # array of @{mmproj; models} for every mmproj seen with more than one
    # distinct `model` name. Returns @() when nothing is shared. Two variants
    # of the same model (e.g. Qwen3.5-2B Q4_K_XL + BF16) that share an
    # mmproj are NOT flagged because the `model` field is identical — they
    # genuinely use the same projector.
    param($catalog)
    $byMmproj = @{}
    foreach ($e in $catalog) {
        if (-not $e -or -not $e.mmproj) { continue }
        if (-not $byMmproj.ContainsKey($e.mmproj)) { $byMmproj[$e.mmproj] = @() }
        $byMmproj[$e.mmproj] += $e.model
    }
    $warnings = @()
    foreach ($kv in $byMmproj.GetEnumerator()) {
        $distinctModels = @($kv.Value | Sort-Object -Unique)
        if ($distinctModels.Count -gt 1) {
            $warnings += [pscustomobject]@{ mmproj = $kv.Key; models = $distinctModels }
        }
    }
    return ,$warnings
}

# ============================================================================
# SUBCOMMAND: plan
# ============================================================================
function Get-Tier {
    param($meta, $cfg)
    if ($meta.is_moe) { return "B" }   # MoE always goes through --n-cpu-moe sweep
    $budget = [int]$cfg.hardware.vram_safety_budget_mib
    $overhead = [int]$cfg.tier_classification.overhead_mib
    $mmprojMib = if ($meta.mmproj) { [int]((Get-Item $meta.mmproj).Length / 1MB) } else { 0 }
    $needed = $meta.size_mib + $mmprojMib + $overhead
    if ($needed -lt $budget) { return "A" }
    return "C"
}

function New-PlanItem {
    param($meta, $tier, $extraArgs, $label, $idx)
    $sanitized = ($meta.model + "_" + $meta.variant) -replace '[^\w]', '_'
    $id = "T{0:D3}_{1}_{2}" -f $idx, $sanitized.Substring(0, [Math]::Min(30, $sanitized.Length)), ($label -replace '[^\w]', '_').Substring(0, [Math]::Min(20, ($label -replace '[^\w]', '_').Length))
    return @{
        id          = $id
        model_path  = $meta.path
        mmproj_path = $meta.mmproj
        model       = $meta.model
        variant     = $meta.variant
        series      = $meta.series
        tier        = $tier
        label       = "$($meta.model) $($meta.variant) @ $label"
        extra_args  = $extraArgs
    }
}

function Get-SampleMaxContextMap {
    # Builds a hashtable {hf_file.ToLower() -> max_context (int)} from
    # samples.json. Used by Invoke-Plan to skip Tier A candidates above
    # the model's officially-supported ctx. User-owned models (not in
    # samples.json by basename) fall through to the global max_context_cap
    # only — a per-model cap for those would require reading GGUF metadata,
    # which is a separate (larger) piece of work.
    $samples = Get-SampleList
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
    $perModelCaps = Get-SampleMaxContextMap

    $plan = @()
    $idx = 1
    foreach ($m in $catalog) {
        if ($Model -and $m.model -notmatch $Model) { continue }
        $tier = Get-Tier -meta $m -cfg $cfg
        if ($Tier -and $tier -ne $Tier) { continue }

        # Per-model ctx cap if the .gguf basename matches a curated sample.
        # User-owned files won't match → $perModelCap stays 0 → only the
        # global cap applies.
        $perModelCap = 0
        $bname = [System.IO.Path]::GetFileName($m.path)
        if ($bname -and $perModelCaps.ContainsKey($bname.ToLower())) {
            $perModelCap = $perModelCaps[$bname.ToLower()]
        }

        switch ($tier) {
            "A" {
                $skipped = 0
                foreach ($c in $cfg.tier_a_candidates) {
                    if (-not (Test-CtxAllowedForModel -Ctx ([int]$c.ctx) -GlobalCap $globalCtxCap -PerModelCap $perModelCap)) {
                        $skipped++
                        continue
                    }
                    $argStr = "--ctx-size $($c.ctx) --gpu-layers 99 --cache-type-k $($c.kv) --cache-type-v $($c.kv) $base"
                    $plan += (New-PlanItem -meta $m -tier $tier -extraArgs $argStr -label "ctx=$($c.ctx)_kv=$($c.kv)" -idx $idx); $idx++
                }
                if ($skipped -gt 0 -and $perModelCap -gt 0) {
                    Write-Host ("  skipped {0} tier-A candidates above {1}'s max_context ({2})" -f $skipped, $m.model, $perModelCap) -ForegroundColor DarkGray
                }
            }
            "B" {
                foreach ($n in $cfg.tier_classification.moe_ncpumoe_sweep) {
                    $argStr = "--ctx-size 16384 --gpu-layers 99 --n-cpu-moe $n --cache-type-k q8_0 --cache-type-v q8_0 $base"
                    $plan += (New-PlanItem -meta $m -tier $tier -extraArgs $argStr -label "ncpumoe_$n" -idx $idx); $idx++
                }
            }
            "C" {
                foreach ($n in $cfg.tier_classification.c_ngl_sweep) {
                    $argStr = "--ctx-size 16384 --gpu-layers $n --cache-type-k q8_0 --cache-type-v q8_0 $base"
                    $plan += (New-PlanItem -meta $m -tier $tier -extraArgs $argStr -label "ngl_$n" -idx $idx); $idx++
                }
            }
        }
    }

    $plan | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $CALIBR_PLAN
    Write-Host ("Plan: {0} test configs -> {1}" -f $plan.Count, $CALIBR_PLAN) -ForegroundColor Green
    if ($DryRun) {
        $plan | ForEach-Object { Write-Host ("  [{0}] {1}" -f $_.tier, $_.label) }
    }
}

# ============================================================================
# WDDM SHARED-GPU MEMORY POLLER (Windows only)
# ============================================================================
function Get-SharedGPUMemoryMib {
    try {
        $c = Get-Counter "\GPU Adapter Memory(*)\Shared Usage" -ErrorAction SilentlyContinue -MaxSamples 1
        if ($c) {
            $total = ($c.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum
            return [int]($total / 1MB)
        }
    } catch { }
    return -1  # unavailable
}

# ============================================================================
# SUBCOMMAND: bench
# ============================================================================
function Get-Median {
    # Median of a numeric collection. Pure: no I/O, no globals. Tested in
    # tests/Helpers.Tests.ps1.
    #
    # - Odd N: middle element after sort.
    # - Even N: lower of the two middle elements (no averaging). The metrics
    #   this is used on (vram_peak_mib, shared_peak_mib) are integer-valued;
    #   an averaged median would introduce non-integer values that mislead
    #   a reader scanning the report.
    # - N = 1: the single element.
    # - Empty / all-null input: $null.
    # - Nulls are filtered before sorting so callers don't have to pre-filter.
    param($values)
    if ($null -eq $values) { return $null }
    $nums = @($values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ })
    if ($nums.Count -eq 0) { return $null }
    $sorted = $nums | Sort-Object
    return $sorted[[int]([math]::Floor(($sorted.Count - 1) / 2))]
}

function New-AggregatedBenchResult {
    # Combine N per-run hashtables (from Invoke-OneBenchRun) plus the
    # planning $item metadata into a single top-level successful result.
    # Varying metrics carry the median over runs; deterministic metrics
    # carry the value from runs[0]. WDDM-derived flags are recomputed
    # from the medians so the top-level reflects median behavior, not
    # run-by-run noise. Pure: no I/O, no globals. Tested in
    # tests/Helpers.Tests.ps1. See spec/n-run-median.md.
    param($item, $cfg, $runs)

    $first = $runs[0]
    $vramTotal = if ($null -ne $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $confirmThresh = if ($null -ne $cfg.wddm_detection.shared_delta_confirm_mib) { [int]$cfg.wddm_detection.shared_delta_confirm_mib } else { 500 }
    $satThresh = if ($null -ne $cfg.wddm_detection.vram_saturation_threshold) { [double]$cfg.wddm_detection.vram_saturation_threshold } else { 0.92 }

    $vramPeakMed   = [int](Get-Median -values @($runs | ForEach-Object { $_.vram_peak_mib }))
    $sharedPeakMed = [int](Get-Median -values @($runs | ForEach-Object { $_.shared_peak_mib }))
    $promptTpsMed  = [math]::Round((Get-Median -values @($runs | ForEach-Object { $_.prompt_tps })), 2)
    $evalTpsMed    = [math]::Round((Get-Median -values @($runs | ForEach-Object { $_.eval_tps })),   2)

    $satRatio = if ($vramTotal -gt 0) { [math]::Round($vramPeakMed / $vramTotal, 3) } else { 0 }
    $flagHighVram  = ($satRatio -gt $satThresh)
    $flagSharedPos = ($sharedPeakMed -gt $confirmThresh)

    $result = [ordered]@{
        id              = $item.id
        label           = $item.label
        model           = $item.model
        variant         = $item.variant
        series          = $item.series
        tier            = $item.tier
        timestamp       = $first.timestamp
        model_path      = $item.model_path
        mmproj_path     = $item.mmproj_path
        extra_args      = $item.extra_args

        # Deterministic / first-run fields
        vram_before_mib  = $first.vram_before_mib
        load_sec         = $first.load_sec
        ready            = $first.ready
        prompt_n         = $first.prompt_n
        eval_n           = $first.eval_n
        cpu_model_mib    = $first.cpu_model_mib
        cuda_model_mib   = $first.cuda_model_mib
        kv_cache_mib     = $first.kv_cache_mib
        compute_cuda_mib = $first.compute_cuda_mib
        compute_host_mib = $first.compute_host_mib
        layers_offloaded = $first.layers_offloaded
        fit_status       = $first.fit_status

        # Median over runs for varying metrics
        vram_peak_mib    = $vramPeakMed
        shared_peak_mib  = $sharedPeakMed
        prompt_tps       = $promptTpsMed
        eval_tps         = $evalTpsMed

        # WDDM-derived recomputed from the medians (not the raw runs)
        wddm_vram_saturation = $satRatio
        wddm_flag_high_vram  = $flagHighVram
        wddm_flag_shared_pos = $flagSharedPos

        ok    = $true
        error = $null

        # Raw per-run records for audit (full schema-of-record for variance work)
        runs  = @($runs)
    }
    return $result
}

function Invoke-OneBenchRun {
    # Execute one warmup-then-bench cycle for $item: spawn llama-server,
    # wait for ready, optional warmup, bench, parse stderr, tear down.
    # Returns a per-run hashtable (measurements + parsed-stderr fields).
    # No caching, no top-level identity fields, no JSON write. Appends to
    # $logFile so a multi-run session has a single log with run delimiters.
    param($item, $cfg, [int]$runIndex, [string]$logFile)

    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400

    $exe   = $cfg.llama_server_exe
    $port  = [int]$cfg.bench.port
    $nPred = [int]$cfg.bench.n_predict
    $prompt= $cfg.bench.prompt

    $argStr = "-m `"$($item.model_path)`""
    if ($item.mmproj_path) { $argStr += " --mmproj `"$($item.mmproj_path)`"" }
    $argStr += " $($item.extra_args) --port $port --host 127.0.0.1 --no-warmup --cache-ram 128"

    $vramBefore = [int]((nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -replace '\s','')
    $sharedBaseline = if ($cfg.wddm_detection.enable_shared_mem_counter) { Get-SharedGPUMemoryMib } else { 0 }
    if ($sharedBaseline -lt 0) { $sharedBaseline = 0 }

    "===== RUN $runIndex =====" | Out-File -Encoding utf8 -Append $logFile
    "[CMD] $exe $argStr" | Out-File -Encoding utf8 -Append $logFile
    "[VRAM before: $vramBefore MiB; shared baseline: $sharedBaseline MiB]" | Out-File -Encoding utf8 -Append $logFile

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argStr
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow  = $true

    $loadStart = Get-Date
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()

    $deadline = (Get-Date).AddSeconds([int]$cfg.bench.wait_sec_ready)
    $ready = $false
    $peakVram = $vramBefore
    $peakShared = 0
    $wc = New-Object System.Net.WebClient
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Milliseconds 500
        $v = [int]((nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -replace '\s','')
        if ($v -gt $peakVram) { $peakVram = $v }
        if ($cfg.wddm_detection.enable_shared_mem_counter) {
            $s = Get-SharedGPUMemoryMib
            if ($s -ge 0) {
                $delta = $s - $sharedBaseline
                if ($delta -gt $peakShared) { $peakShared = $delta }
            }
        }
        try {
            $content = $wc.DownloadString("http://127.0.0.1:$port/v1/models")
            if ($content.Length -gt 10) { $ready = $true; break }
        } catch { }
    }
    $wc.Dispose()
    $loadSec = [math]::Round(((Get-Date) - $loadStart).TotalSeconds, 2)

    $run = [ordered]@{
        run_index       = $runIndex
        timestamp       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        vram_before_mib = $vramBefore
        vram_peak_mib   = $peakVram
        shared_peak_mib = $peakShared
        load_sec        = $loadSec
        ready           = $ready
        ok              = $false
        error           = $null
    }

    if ($ready) {
        if ($cfg.bench.warmup) {
            try {
                $wBody = @{ prompt=$prompt; n_predict=8; temperature=0.0; cache_prompt=$true; stream=$false } | ConvertTo-Json -Compress
                Invoke-RestMethod -Uri "http://127.0.0.1:$port/completion" -Method Post -Body $wBody -ContentType "application/json" -TimeoutSec 300 | Out-Null
            } catch { }
        }

        $body = @{ prompt=$prompt; n_predict=$nPred; temperature=0.0; cache_prompt=$false; stream=$false } | ConvertTo-Json -Compress
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/completion" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 900
            $run.ok = $true
            if ($resp.timings) {
                $run.prompt_n   = $resp.timings.prompt_n
                $run.prompt_tps = [math]::Round($resp.timings.prompt_per_second, 2)
                $run.eval_n     = $resp.timings.predicted_n
                $run.eval_tps   = [math]::Round($resp.timings.predicted_per_second, 2)
            }
        } catch { $run.error = $_.Exception.Message }

        $v = [int]((nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -replace '\s','')
        if ($v -gt $run.vram_peak_mib) { $run.vram_peak_mib = $v }
        if ($cfg.wddm_detection.enable_shared_mem_counter) {
            $s = Get-SharedGPUMemoryMib
            if ($s -ge 0) {
                $delta = $s - $sharedBaseline
                if ($delta -gt $run.shared_peak_mib) { $run.shared_peak_mib = $delta }
            }
        }
    }

    if (-not $p.HasExited) { try { $p.Kill() } catch { } }
    Start-Sleep -Milliseconds 700
    try { $err = $errTask.GetAwaiter().GetResult() } catch { $err = "" }

    "`n===== STDERR (run $runIndex) =====" | Out-File -Encoding utf8 -Append $logFile
    $err | Out-File -Encoding utf8 -Append $logFile

    $patterns = @{
        cpu_model_mib    = 'CPU model buffer size\s*=\s*([\d\.]+)'
        cuda_model_mib   = 'CUDA0 model buffer size\s*=\s*([\d\.]+)'
        kv_cache_mib     = 'CUDA0 KV buffer size\s*=\s*([\d\.]+)'
        compute_cuda_mib = 'CUDA0 compute buffer size\s*=\s*([\d\.]+)'
        compute_host_mib = 'CUDA_Host compute buffer size\s*=\s*([\d\.]+)'
        layers_offloaded = 'offloaded (\d+)/(\d+) layers'
    }
    foreach ($k in $patterns.Keys) {
        $m = [regex]::Match($err, $patterns[$k])
        if ($m.Success) {
            if ($k -eq 'layers_offloaded') { $run[$k] = "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }
            else { $run[$k] = [double]$m.Groups[1].Value }
        }
    }
    # Trap llama.cpp builds that don't recognize a model's architecture (e.g.
    # an older build vs. a brand-new lineage). Surface the architecture name
    # so the caller can short-circuit further tests on the same model.
    $mArch = [regex]::Match($err, "unknown model architecture: '([^']+)'")
    if ($mArch.Success) { $run.unsupported_architecture = $mArch.Groups[1].Value }
    if ($err -match 'successfully fit params') { $run.fit_status = "success" }
    elseif ($err -match 'failed to fit params') { $run.fit_status = "failed_but_running" }
    else { $run.fit_status = "unknown" }

    $vramTotal = if ($null -ne $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $satRatio = if ($vramTotal -gt 0) { $run.vram_peak_mib / $vramTotal } else { 0 }
    $run.wddm_vram_saturation = [math]::Round($satRatio, 3)
    $run.wddm_flag_high_vram  = ($satRatio -gt $cfg.wddm_detection.vram_saturation_threshold)
    $confirmThresh = if ($cfg.wddm_detection.shared_delta_confirm_mib) { [int]$cfg.wddm_detection.shared_delta_confirm_mib } else { 500 }
    $run.wddm_flag_shared_pos = ($run.shared_peak_mib -gt $confirmThresh)

    return $run
}

function Invoke-OneBench {
    # Drive N runs of a single planning $item and persist one result file.
    # Cache check follows spec/n-run-median.md "Cache invalidation": failed
    # results are cached as-is (definitive negative); successful results
    # need a `runs` array of length N to be cache-hits; pre-v1.1.0 success
    # files (no `runs` array) are treated as length-one for `-Runs 1` only.
    # On any single-run failure, writes the existing single-record failure
    # JSON (no `runs` array) and returns immediately; preserves the v1.0.0
    # unsupported_architecture short-circuit.
    param($item, $cfg)

    $jsonFile = Join-Path $CALIBR_RESULTS_DIR "$($item.id).json"
    $logFile  = Join-Path $CALIBR_LOGS_DIR    "$($item.id).log"
    $confirmMibLocal = if ($cfg.wddm_detection -and $null -ne $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }

    # Resolve N: CLI flag > config > default 3. Minimum 1.
    $N = if ($Runs -gt 0) { $Runs }
         elseif ($null -ne $cfg.bench.runs_per_config) { [int]$cfg.bench.runs_per_config }
         else { 3 }
    if ($N -lt 1) { $N = 1 }

    # Cache check
    if ((Test-Path $jsonFile) -and (-not $Force)) {
        $cached = Get-Content $jsonFile -Raw | ConvertFrom-Json
        if (-not $cached.ok) {
            Write-Host ("[{0}] cached failure (use -Force to retry)" -f $item.id) -ForegroundColor DarkGray
            return $cached
        }
        if ($null -ne $cached.runs -and $cached.runs.Count -eq $N) {
            Write-Host ("[{0}] cached N={1} (use -Force to rerun)" -f $item.id, $N) -ForegroundColor DarkGray
            return $cached
        }
        if ($null -eq $cached.runs -and $N -eq 1) {
            Write-Host ("[{0}] cached legacy N=1 (use -Force to rerun)" -f $item.id) -ForegroundColor DarkGray
            return $cached
        }
        $haveN = if ($null -ne $cached.runs) { $cached.runs.Count } else { 0 }
        Write-Host ("[{0}] cache miss (have N={1}, want N={2}) - re-running" -f $item.id, $haveN, $N) -ForegroundColor DarkGray
    }

    # Fresh log for this bench session
    Set-Content -Encoding utf8 -Path $logFile -Value ""

    $runs = @()
    for ($i = 0; $i -lt $N; $i++) {
        if ($N -gt 1) {
            Write-Host ("  run {0}/{1}" -f ($i + 1), $N) -ForegroundColor DarkGray
        }
        $r = Invoke-OneBenchRun -item $item -cfg $cfg -runIndex $i -logFile $logFile

        if (-not $r.ok) {
            # Single-record failure shape (no `runs` array): definitive
            # negative cached as-is. Preserves the v1.0.0 model-skip path.
            $failResult = [ordered]@{
                id              = $item.id
                label           = $item.label
                model           = $item.model
                variant         = $item.variant
                series          = $item.series
                tier            = $item.tier
                timestamp       = $r.timestamp
                model_path      = $item.model_path
                mmproj_path     = $item.mmproj_path
                extra_args      = $item.extra_args
                vram_before_mib = $r.vram_before_mib
                vram_peak_mib   = $r.vram_peak_mib
                shared_peak_mib = $r.shared_peak_mib
                load_sec        = $r.load_sec
                ready           = $r.ready
                ok              = $false
                error           = $r.error
                cpu_model_mib   = $r.cpu_model_mib
                cuda_model_mib  = $r.cuda_model_mib
                kv_cache_mib    = $r.kv_cache_mib
                compute_cuda_mib = $r.compute_cuda_mib
                compute_host_mib = $r.compute_host_mib
                layers_offloaded = $r.layers_offloaded
                fit_status      = $r.fit_status
                unsupported_architecture = $r.unsupported_architecture
                wddm_vram_saturation = $r.wddm_vram_saturation
                wddm_flag_high_vram  = $r.wddm_flag_high_vram
                wddm_flag_shared_pos = $r.wddm_flag_shared_pos
            }
            $failResult.failure_reason = Get-FailureReason -result $failResult -sharedConfirmMib $confirmMibLocal
            $failResult | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile
            Write-BenchStatusLine -item $item -result $failResult
            return $failResult
        }

        $runs += $r
    }

    $aggregated = New-AggregatedBenchResult -item $item -cfg $cfg -runs $runs
    # All N runs succeeded so failure_reason is unset (null). Recording it as
    # null (rather than omitting) keeps every result's schema identical, which
    # simplifies report.template.html's column rendering.
    $aggregated.failure_reason = Get-FailureReason -result $aggregated -sharedConfirmMib $confirmMibLocal
    $aggregated | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile
    Write-BenchStatusLine -item $item -result $aggregated
    return $aggregated
}

function Write-BenchStatusLine {
    # Print the per-config result line. Identical wording to v1.0.x; the
    # numbers shown are now medians for successful N>1 results. Pure
    # presentation; no return value.
    param($item, $result)
    $tag = if ($result.ok) { "[OK]  " } else { "[FAIL]" }
    $tagColor = if ($result.ok) { 'Green' } else { 'Red' }
    if ($result.ok) {
        $detail = "prompt={0,6}t/s   eval={1,5}t/s   peak={2} MiB" -f $result.prompt_tps, $result.eval_tps, $result.vram_peak_mib
        if ($result.wddm_flag_shared_pos)    { $detail += "   [WDDM: shared=+$($result.shared_peak_mib)MiB]" }
        elseif ($result.wddm_flag_high_vram) { $detail += "   [WDDM: VRAM $([int]($result.wddm_vram_saturation*100))%]" }
    } elseif ($result.unsupported_architecture) {
        $detail = "(unsupported architecture: $($result.unsupported_architecture))"
    } elseif (-not $result.ready) {
        $detail = "(server didn't become ready)"
    } else {
        $detail = "(completion failed)"
    }
    Write-Host ("{0} {1,-55} {2}" -f $tag, $item.label, $detail) -ForegroundColor $tagColor
}

function Get-FailureReason {
    # Classify why a bench result is not ok into one of four buckets so
    # downstream code (rotation, abandonment, reports) can act on it
    # without re-parsing scattered signals. Returns one of:
    #   vram_overflow      - WDDM paged into shared memory; the model
    #                        couldn't fit in real VRAM. fit_status said
    #                        'failed_but_running' OR shared_peak crossed
    #                        the confirm threshold.
    #   server_timeout     - llama-server never became ready in time, but
    #                        no VRAM-pressure signal fired. Build/CUDA bug,
    #                        broken model file, port conflict, etc.
    #   unsupported_arch   - the v1.0 short-circuit: llama.cpp doesn't
    #                        know this architecture yet (update llama.cpp).
    #   other              - catch-all for $result.ok=false without any
    #                        of the above signals.
    # Returns $null when $result.ok is true (no failure to classify).
    param($result, [int]$sharedConfirmMib = 500)
    if ($null -eq $result) { return $null }
    if ($result.ok) { return $null }
    if ($result.unsupported_architecture) { return "unsupported_arch" }
    $shared = if ($null -ne $result.shared_peak_mib) { [int]$result.shared_peak_mib } else { 0 }
    if ($result.fit_status -eq "failed_but_running" -or $shared -gt $sharedConfirmMib) {
        return "vram_overflow"
    }
    if ($result.ready -eq $false) { return "server_timeout" }
    return "other"
}

function Select-PlanForBench {
    # Pure filter: applies the same -Model/-Tier/-Id rules Invoke-Bench uses,
    # returns an array (possibly empty). The leading `$_ -and` is load-bearing:
    # PowerShell's `$null | Where-Object` yields one $null item, and @() wraps
    # it to a 1-element array, which would then crash the rotation context
    # build with ContainsKey($null). The same pattern protects against any
    # other malformed plan entry that managed to become $null mid-pipeline.
    param(
        $plan,
        [string]$ModelFilter = "",
        [string]$TierFilter = "",
        [string]$IdFilter = ""
    )
    return ,@($plan | Where-Object {
        $_ -and
        (-not $ModelFilter -or $_.model -match $ModelFilter) -and
        (-not $TierFilter  -or $_.tier  -eq $TierFilter) -and
        (-not $IdFilter    -or $_.id    -like $IdFilter)
    })
}

function Invoke-RotationCheck {
    # Called once per config-iteration in Invoke-Bench. If $item's model_path
    # has reached its expected config count, decides whether to rotate (delete
    # the .gguf and possibly its mmproj) and emits a host line either way.
    #
    # Reasons we KEEP a file:
    #   - $KeepDownloads flag set
    #   - file is not in the download manifest (user-owned)
    #   - one or more configs for the model failed (incl. abandoned-as-skip)
    #
    # mmproj is deleted only when no other not-yet-rotated model in $filtered
    # still references it on disk. Avoids breaking a later same-bench config
    # of a sibling variant that happens to share the projector file.
    param(
        $item,
        [hashtable]$modelStatus,
        $filtered,
        [ref]$rotatedRef,
        [ref]$keptRef
    )
    $mp = $item.model_path
    $st = $modelStatus[$mp]
    if (-not $st) { return }
    if ($st.done -ne $st.needed) { return }
    if ($st.rotated) { return }
    $st.rotated = $true

    if ($KeepDownloads) {
        Write-Host ("[rotate] kept {0} (-KeepDownloads)" -f $mp) -ForegroundColor DarkGray
        $keptRef.Value++
        return
    }
    if (-not (Test-DownloadedByCalibr -Path $mp)) {
        # Silent for user-owned files; printing for every model would spam.
        $keptRef.Value++
        return
    }
    if ($st.fail -gt 0 -or $st.skip -gt 0) {
        $reasonParts = @()
        if ($st.fail -gt 0) { $reasonParts += "$($st.fail) failed" }
        if ($st.skip -gt 0) { $reasonParts += "$($st.skip) skipped" }
        Write-Host ("[rotate] kept {0} ({1})" -f $mp, ($reasonParts -join ", ")) -ForegroundColor Yellow
        $keptRef.Value++
        return
    }

    # All clean. Delete model file.
    if (Test-Path -LiteralPath $mp) {
        try {
            Remove-Item -LiteralPath $mp -Force -ErrorAction Stop
            Write-Host ("[rotate] deleted {0}" -f $mp) -ForegroundColor DarkCyan
            $rotatedRef.Value++
        } catch {
            Write-Host ("[rotate] FAILED to delete {0}: {1}" -f $mp, $_.Exception.Message) -ForegroundColor Red
            return
        }
    } else {
        # File already gone (e.g. user moved it mid-bench). Nothing to do.
    }

    # Maybe delete mmproj. Only if no other not-yet-rotated model in $filtered
    # still references the same projector path.
    if ($st.mmprojPath) {
        $stillNeeded = $false
        foreach ($other in $filtered) {
            if ($other.model_path -eq $mp) { continue }
            if ($other.mmproj_path -ieq $st.mmprojPath) {
                $otherSt = $modelStatus[$other.model_path]
                if ($otherSt -and -not $otherSt.rotated) {
                    $stillNeeded = $true
                    break
                }
            }
        }
        if (-not $stillNeeded -and (Test-Path -LiteralPath $st.mmprojPath)) {
            try {
                Remove-Item -LiteralPath $st.mmprojPath -Force -ErrorAction Stop
                Write-Host ("[rotate] deleted {0} (mmproj)" -f $st.mmprojPath) -ForegroundColor DarkCyan
            } catch {
                Write-Host ("[rotate] FAILED to delete mmproj {0}: {1}" -f $st.mmprojPath, $_.Exception.Message) -ForegroundColor Red
            }
        }
    }

    # Cleanup the now-empty parent directory the .gguf lived in. Use
    # System.IO.Path.GetDirectoryName instead of Split-Path: PS 5.1's
    # Split-Path -LiteralPath -Parent triggers a parameter-set ambiguity.
    # We use DirectoryInfo for the empty-check + delete to make the
    # 'only if empty' intent explicit and to avoid Remove-Item's own
    # parameter-set quirks on directories. If anything is still in the
    # dir (user files, sibling .gguf, hidden files), we leave it alone.
    $parentDir = [System.IO.Path]::GetDirectoryName($mp)
    if ($parentDir -and (Test-Path -LiteralPath $parentDir)) {
        try {
            $info = New-Object System.IO.DirectoryInfo($parentDir)
            if ($info.GetFileSystemInfos().Length -eq 0) {
                $info.Delete()
            }
        } catch { }
    }
}

function Invoke-Bench {
    $cfg = Get-Config
    if (-not $cfg.llama_server_exe -or -not (Test-Path $cfg.llama_server_exe)) {
        throw "llama_server_exe missing or invalid. Run 'calibr init'."
    }
    if (-not (Test-Path $CALIBR_PLAN)) { throw "plan.json missing. Run 'calibr plan'." }
    $planRaw = Get-Content $CALIBR_PLAN -Raw | ConvertFrom-Json
    $plan = ConvertTo-Hashtable -obj $planRaw

    Write-Host "=== bench ===" -ForegroundColor Cyan

    # Backend cross-check: detect available llama.cpp backends and warn if the
    # build doesn't match the GPU (e.g. NVIDIA card with a Vulkan-only build).
    $backends = Get-LlamaBackends -exe $cfg.llama_server_exe
    $availList = @($backends.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key } | Sort-Object)
    $availStr = if ($availList.Count -gt 0) { $availList -join ', ' } else { '(none)' }
    Write-Host ("llama.cpp backends available: {0}" -f $availStr) -ForegroundColor DarkGray
    foreach ($w in (Test-BackendHealthy -cfg $cfg -backends $backends)) {
        Write-Host "WARNING: $w" -ForegroundColor Yellow
    }

    $filtered = Select-PlanForBench -plan $plan -ModelFilter $Model -TierFilter $Tier -IdFilter $Id
    $planCount = if ($plan) { @($plan).Count } else { 0 }
    Write-Host ("{0} configs to run (filtered from {1})" -f $filtered.Count, $planCount)

    if ($filtered.Count -eq 0) {
        if ($planCount -eq 0) {
            Write-Host "Plan is empty. Run 'calibr discover' (with .gguf files in scan_paths) then 'calibr plan' first." -ForegroundColor Yellow
        } else {
            Write-Host "No configs match the current filter (-Model / -Tier / -Id). Plan has $planCount configs total." -ForegroundColor Yellow
        }
        return
    }

    if ($DryRun) {
        $filtered | ForEach-Object { Write-Host ("  [{0}] {1}" -f $_.tier, $_.label) }
        return
    }

    $total      = $filtered.Count
    $startTime  = Get-Date
    $abandoned  = @{}
    $okCount    = 0
    $failCount  = 0
    $skipCount  = 0
    $i = 0
    # Threshold used by Get-FailureReason to decide vram_overflow vs other.
    # Mirrors the value used in Invoke-OneBenchRun / New-AggregatedBenchResult
    # for the WDDM flag so all three views agree.
    $confirmThresh = if ($cfg.wddm_detection -and $null -ne $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }

    # Rotation context: per-distinct-model_path tracking so we know when every
    # config touching a given .gguf is accounted for and can decide whether to
    # delete the file. We index by model_path (not model name) because the same
    # name could theoretically resolve to different files across scan paths.
    $modelStatus = @{}
    foreach ($item in $filtered) {
        $mp = $item.model_path
        if (-not $modelStatus.ContainsKey($mp)) {
            $modelStatus[$mp] = @{
                needed      = 0
                ok          = 0
                fail        = 0
                skip        = 0
                done        = 0
                modelName   = $item.model
                mmprojPath  = $item.mmproj_path
                rotated     = $false
            }
        }
        $modelStatus[$mp].needed++
    }
    $rotatedCount = 0
    $keptCount    = 0

    foreach ($item in $filtered) {
        $i++
        $mp = $item.model_path

        if ($abandoned.ContainsKey($item.model)) {
            $reason = $abandoned[$item.model]
            Write-Host ("[SKIP] {0,-55} ({1})" -f $item.label, $reason) -ForegroundColor DarkYellow
            $skipCount++
            $modelStatus[$mp].skip++
            $modelStatus[$mp].done++
            Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered $filtered -rotatedRef ([ref]$rotatedCount) -keptRef ([ref]$keptCount)
            continue
        }

        $elapsed = (Get-Date) - $startTime
        $etaStr = "?"
        if ($i -gt 1) {
            $etaSec = ($elapsed.TotalSeconds / ($i - 1)) * ($total - $i + 1)
            $etaStr = "{0}m{1:D2}s" -f ([int]($etaSec / 60)), ([int]($etaSec % 60))
        }
        $pct = if ($total -gt 0) { (($i - 1) / $total) * 100 } else { 0 }

        Write-Progress -Activity "calibr bench" `
                       -Status   "[$i/$total] running - ETA $etaStr" `
                       -CurrentOperation $item.label `
                       -PercentComplete $pct

        Write-Host ("`n[$i/$total] $($item.label)") -ForegroundColor Cyan
        $r = Invoke-OneBench -item $item -cfg $cfg
        if ($r.ok) {
            $okCount++
            $modelStatus[$mp].ok++
        } else {
            $failCount++
            $modelStatus[$mp].fail++
        }
        $modelStatus[$mp].done++

        if (-not $r.ok -and $r.unsupported_architecture) {
            $abandoned[$item.model] = "unsupported architecture '$($r.unsupported_architecture)'"
            Write-Host "  -> abandoning remaining tests for model '$($item.model)' (update llama.cpp to fix)" -ForegroundColor DarkYellow
        }

        # Tier-aware abandonment on VRAM overflow. Tier A sweeps ctx
        # ascending: if the smallest ctx already pages, larger ctxs make
        # it worse. Tier C sweeps gpu-layers ascending: if 20 already
        # pages, 24..36 push even more onto GPU. Tier B sweeps
        # n-cpu-moe ascending = MORE on CPU = LESS GPU pressure, so a
        # failure on 28 (most-on-GPU) does NOT predict failure on 36;
        # do not abandon Tier B on vram_overflow.
        if (-not $r.ok -and -not $abandoned.ContainsKey($item.model)) {
            $reason = Get-FailureReason -result $r -sharedConfirmMib $confirmThresh
            if ($reason -eq "vram_overflow" -and ($item.tier -eq "A" -or $item.tier -eq "C")) {
                $abandoned[$item.model] = "vram overflow at smallest config in tier $($item.tier) sweep; larger configs will be worse"
                Write-Host ("  -> abandoning remaining tier {0} tests for model '{1}' (vram overflow detected; bigger ctx/ngl can only worsen it)" -f $item.tier, $item.model) -ForegroundColor DarkYellow
            }
        }

        Invoke-RotationCheck -item $item -modelStatus $modelStatus -filtered $filtered -rotatedRef ([ref]$rotatedCount) -keptRef ([ref]$keptCount)
    }

    Write-Progress -Activity "calibr bench" -Completed

    # Final summary
    $duration = (Get-Date) - $startTime
    $durStr = "{0}m{1:D2}s" -f ([int]$duration.TotalMinutes), ([int]($duration.TotalSeconds % 60))
    $bar = ("=" * 63)
    Write-Host ""
    Write-Host $bar -ForegroundColor Cyan
    Write-Host (" calibr bench - done in $durStr") -ForegroundColor Cyan
    Write-Host ("   {0} ok . {1} fail . {2} skipped (out of {3})" -f $okCount, $failCount, $skipCount, $total)
    if ($abandoned.Count -gt 0) {
        Write-Host ("   abandoned families: {0}" -f (($abandoned.Keys) -join ', ')) -ForegroundColor DarkYellow
        $reasons = @($abandoned.Values | Sort-Object -Unique)
        Write-Host ("   reason: {0}" -f ($reasons -join '; ')) -ForegroundColor DarkYellow
    }
    if ($rotatedCount -gt 0 -or ($keptCount -gt 0 -and -not $KeepDownloads)) {
        Write-Host ("   rotated: {0} deleted . {1} kept" -f $rotatedCount, $keptCount) -ForegroundColor DarkCyan
    }
    Write-Host $bar -ForegroundColor Cyan
}

# ============================================================================
# SUBCOMMAND: report
# ============================================================================
function Test-IsBetterWinner {
    # Decide whether $candidate should replace $current as the winner of its
    # group. Default rule: a non-paging config always beats a paging one;
    # among equally-safe configs, higher eval_tps wins. With -PreferSpeed:
    # safety is ignored, raw eval_tps is the only criterion.
    #
    # "Paging" means shared_peak_mib > $sharedConfirmMib. The default 500 MiB
    # matches wddm_detection.shared_delta_confirm_mib so the picker and the
    # report watchlist agree: small drift from background apps (Chrome, Discord)
    # at ~200-300 MiB is NOT counted as paging.
    #
    # Pure: no I/O, no globals, used by Invoke-Report and unit tests.
    param($candidate, $current, [switch]$preferSpeed, [int]$sharedConfirmMib = 500)
    if (-not $current) { return $true }
    if ($preferSpeed) { return ([double]$candidate.eval_tps -gt [double]$current.eval_tps) }
    $cSafe   = ([int]$candidate.shared_peak_mib -le $sharedConfirmMib)
    $curSafe = ([int]$current.shared_peak_mib   -le $sharedConfirmMib)
    if ($cSafe -and -not $curSafe) { return $true }
    if (-not $cSafe -and $curSafe) { return $false }
    return ([double]$candidate.eval_tps -gt [double]$current.eval_tps)
}

function Get-ResultDerivedFields {
    # Compute the derived metrics the report's charts need from a raw result.
    # Pure: no I/O, no globals. Tested in tests/Helpers.Tests.ps1.
    #   time_total_sec = prompt_n / prompt_tps + eval_n / eval_tps
    #   headroom_mib   = max(0, vram_total_mib - vram_peak_mib)
    #   ctx_size       = parsed from `--ctx-size N` in extra_args (else $null)
    param($result, [int]$vramTotal)

    $promptN  = if ($null -ne $result.prompt_n) { [int]$result.prompt_n } else { 0 }
    $evalN    = if ($null -ne $result.eval_n)   { [int]$result.eval_n }   else { 0 }
    $promptTs = if ($null -ne $result.prompt_tps) { [double]$result.prompt_tps } else { 0 }
    $evalTs   = if ($null -ne $result.eval_tps)   { [double]$result.eval_tps }   else { 0 }

    $timeTotal = $null
    if ($promptN -gt 0 -and $evalN -gt 0 -and $promptTs -gt 0 -and $evalTs -gt 0) {
        $timeTotal = [math]::Round(($promptN / $promptTs) + ($evalN / $evalTs), 2)
    }

    $vramPeak = if ($null -ne $result.vram_peak_mib) { [int]$result.vram_peak_mib } else { 0 }
    $headroom = [Math]::Max(0, $vramTotal - $vramPeak)

    $ctxSize = $null
    if ($result.extra_args -and ($result.extra_args -match '--ctx-size\s+(\d+)')) {
        $ctxSize = [int]$Matches[1]
    }

    return @{
        time_total_sec = $timeTotal
        headroom_mib   = $headroom
        ctx_size       = $ctxSize
    }
}

function Invoke-Report {
    $cfg = Get-Config
    Write-Host "=== report ===" -ForegroundColor Cyan

    $results = @()
    Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" | Sort-Object Name | ForEach-Object {
        $r = Get-Content $_.FullName -Raw | ConvertFrom-Json
        $results += $r
    }
    if ($results.Count -eq 0) { throw "No results. Run 'calibr bench' first." }

    # v1.0 migration: pre-v1 result JSONs used `family` and `quant`. Detect
    # any in the loaded set, backfill model/variant/series, and rewrite the
    # file so subsequent runs are clean. Idempotent.
    $migrated = 0
    foreach ($jsonFile in (Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" -ErrorAction SilentlyContinue)) {
        $r = Get-Content $jsonFile.FullName -Raw | ConvertFrom-Json
        $touched = $false
        if ($null -eq $r.model -and $r.PSObject.Properties.Name -contains 'family') {
            $r | Add-Member -NotePropertyName model -NotePropertyValue $r.family -Force
            $touched = $true
        }
        if ($null -eq $r.variant -and $r.PSObject.Properties.Name -contains 'quant') {
            $r | Add-Member -NotePropertyName variant -NotePropertyValue $r.quant -Force
            $touched = $true
        }
        if ($null -eq $r.series -and $r.model) {
            $s = $r.model
            if ($s -match '^(.+?)-[A-Z]?\d+(\.\d+)?B(-A\d+B)?(-it|-Instruct)?$') { $s = $Matches[1] }
            $r | Add-Member -NotePropertyName series -NotePropertyValue $s -Force
            $touched = $true
        }
        if ($touched) {
            $r.PSObject.Properties.Remove('family') | Out-Null
            $r.PSObject.Properties.Remove('quant')  | Out-Null
            $r | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $jsonFile.FullName
            $migrated++
        }
    }
    if ($migrated -gt 0) {
        Write-Host ("migrated {0} result file(s) to v1 schema" -f $migrated) -ForegroundColor DarkGray
        # Reload the now-migrated results so the rest of the function sees the new shape.
        $results = @()
        Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" | Sort-Object Name | ForEach-Object {
            $results += (Get-Content $_.FullName -Raw | ConvertFrom-Json)
        }
    }

    # Pick winner per grouping key (model, or model+variant if -GroupBy model+variant).
    # Default safety rule: a config without WDDM paging always beats one that pages.
    # With -PreferSpeed: ignore safety, pick the highest eval_tps.
    function Get-GroupKey {
        param($r, $mode)
        if ($mode -eq "model+variant") { return "$($r.model)_$($r.variant)" }
        return $r.model
    }

    $confirmMib = if ($cfg.wddm_detection -and $cfg.wddm_detection.shared_delta_confirm_mib) {
        [int]$cfg.wddm_detection.shared_delta_confirm_mib
    } else { 500 }
    $winners = @{}
    foreach ($r in ($results | Where-Object { $_.ok })) {
        $key = Get-GroupKey -r $r -mode $GroupBy
        if (Test-IsBetterWinner -candidate $r -current $winners[$key] -preferSpeed:$PreferSpeed -sharedConfirmMib $confirmMib) {
            $winners[$key] = $r
        }
    }

    Write-Host ("Grouping by '{0}'; produced {1} winner(s)" -f $GroupBy, $winners.Count)

    # Generate .bat per winner
    foreach ($key in $winners.Keys) {
        $w = $winners[$key]
        $batName = ($key -replace '[^\w\.\-]', '_') + ".bat"
        $batPath = Join-Path $CALIBR_BATS_DIR $batName
        # Split extra_args into pairs "--flag value" or bare switches "--flag"
        # Regex grabs a `--name` and optionally its following non-flag value.
        $pairs = [regex]::Matches($w.extra_args, '(--\S+)(?:\s+("[^"]*"|[^-\s]\S*))?') |
                 ForEach-Object { $_.Value.Trim() }
        $lines = @(
            "@echo off"
            "REM Auto-generated by calibr on $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
            "REM Model: $key"
            "REM Bench: prompt=$($w.prompt_tps) t/s, eval=$($w.eval_tps) t/s, VRAM peak=$($w.vram_peak_mib) MiB"
            "REM Test ID: $($w.id)"
            ""
            "`"$($cfg.llama_server_exe)`" ^"
            "    -m `"$($w.model_path)`" ^"
        )
        if ($w.mmproj_path) { $lines += "    --mmproj `"$($w.mmproj_path)`" ^" }
        foreach ($pair in $pairs) { $lines += "    $pair ^" }
        $lines += "    --metrics"
        $lines -join "`r`n" | Out-File -Encoding ascii $batPath
        Write-Host "  wrote $batName"
    }

    # Build HTML (compact, self-contained)
    $cfgJson = $cfg | ConvertTo-Json -Depth 5 -Compress
    $vramTotal = if ($cfg.hardware -and $cfg.hardware.vram_total_mib) { [int]$cfg.hardware.vram_total_mib } else { 0 }
    $resJson = ($results | ForEach-Object {
        $r = $_
        $derived = Get-ResultDerivedFields -result $r -vramTotal $vramTotal
        $kvCache = if ($null -ne $r.kv_cache_mib) { [double]$r.kv_cache_mib } else { 0 }
        [ordered]@{
            id=$r.id; label=$r.label; model=$r.model; series=$r.series; variant=$r.variant; tier=$r.tier
            prompt_tps=([double]$r.prompt_tps); eval_tps=([double]$r.eval_tps)
            vram_peak_mib=([int]$r.vram_peak_mib); shared_peak_mib=([int]$r.shared_peak_mib)
            load_sec=([double]$r.load_sec); layers_offloaded=$r.layers_offloaded
            fit_status=$r.fit_status; wddm_vram_saturation=([double]$r.wddm_vram_saturation)
            wddm_flag_high_vram=$r.wddm_flag_high_vram; wddm_flag_shared_pos=$r.wddm_flag_shared_pos
            extra_args=$r.extra_args; ok=$r.ok
            # Derived for the new charts and the headroom annotation:
            time_total_sec=$derived.time_total_sec
            headroom_mib=$derived.headroom_mib
            ctx_size=$derived.ctx_size
            kv_cache_mib=$kvCache
        }
    }) | ConvertTo-Json -Depth 5 -Compress
    $winJson = ($winners.GetEnumerator() | ForEach-Object {
        [ordered]@{ model=$_.Key; winner_id=$_.Value.id; bat=(($_.Key -replace '[^\w\.\-]','_') + ".bat") }
    }) | ConvertTo-Json -Depth 5 -Compress

    $now = (Get-Date).ToString("yyyy-MM-dd HH:mm")
    $templatePath = Join-Path $CALIBR_ROOT "report.template.html"
    if (-not (Test-Path $templatePath)) { throw "Missing report.template.html" }
    # -Encoding UTF8 is required: the template contains characters outside
    # ASCII (e.g. the ≈ glyph in the headroom annotation). PS 5.1's default
    # is the system code page (Windows-1252 on Italian Windows), which would
    # silently mojibake those bytes on read and then re-encode the garbage
    # as 'valid' UTF-8 on write.
    $html = Get-Content $templatePath -Raw -Encoding UTF8
    $html = $html.Replace("%%NOW%%", $now).Replace("%%DATA%%", $resJson).Replace("%%WINNERS%%", $winJson).Replace("%%CFG%%", $cfgJson)
    $html | Out-File -Encoding utf8 $CALIBR_REPORT
    Write-Host "Report: $CALIBR_REPORT" -ForegroundColor Green
}

# ============================================================================
# SUBCOMMAND: get-sample-models
# ============================================================================
function Get-SampleList {
    $samplesFile = Join-Path $CALIBR_ROOT "samples.json"
    if (-not (Test-Path $samplesFile)) { throw "samples.json missing at $samplesFile" }
    $raw = Get-Content $samplesFile -Raw | ConvertFrom-Json
    return $raw.samples
}

# Download manifest: records which .gguf files calibr itself fetched. Used by
# bench's post-config rotation step to decide whether a file is safe to delete
# (entries in the manifest = downloaded by calibr; absence = user-owned, never
# touched). Manifest entries are kept after the file is rotated off disk so a
# re-download via `get-sample-models -SampleId` is one command.
function Get-DownloadManifest {
    # Emits each manifest entry as its own pipeline value (or no values if
    # the file is missing/empty/corrupt). Enumerating here, instead of
    # returning the parsed array as a single pipeline value, is what lets
    # callers do `@(Get-DownloadManifest)` and get a flat array — otherwise
    # the @() would wrap the entire parsed array as a single element, and
    # downstream Where-Object/foreach would treat the whole manifest as
    # one item. PS 5.1's ConvertFrom-Json returns the JSON array as one
    # pipeline value, so we re-enumerate explicitly.
    if (-not (Test-Path $CALIBR_DOWNLOADS)) { return }
    $raw = Get-Content $CALIBR_DOWNLOADS -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return }
    try {
        $parsed = $raw | ConvertFrom-Json
        foreach ($entry in $parsed) { $entry }
    } catch {
        Write-Warning "downloads.json is corrupt; treating as empty. ($($_.Exception.Message))"
    }
}

function Add-DownloadManifestEntry {
    # Idempotent on $ModelPath: replaces an existing entry rather than duplicating
    # so re-running `get-sample-models` for the same sample updates the timestamp
    # in place.
    param(
        [Parameter(Mandatory)][string]$SampleId,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][string]$ModelPath,
        [string]$MmprojPath = "",
        [long]$SizeBytes = 0
    )
    # Get-DownloadManifest emits one entry per pipeline value; piping to
    # Where-Object filters by path, @() collects into an array (empty if
    # no entries match). $_ -and guards against phantom $null entries that
    # an empty/corrupt manifest could otherwise let through.
    $existing = @(Get-DownloadManifest | Where-Object { $_ -and $_.model_path -ne $ModelPath })
    $entry = [ordered]@{
        sample_id     = $SampleId
        model         = $Model
        model_path    = $ModelPath
        mmproj_path   = if ($MmprojPath) { $MmprojPath } else { $null }
        size_bytes    = $SizeBytes
        downloaded_at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $manifest = @($existing + $entry)
    # -InputObject (rather than pipeline) keeps a 1-element array serialized
    # as [{...}] instead of the bare object {...} that the pipeline form
    # would emit. Round-tripping stays an array either way (Get's caller @()
    # wrap handles the bare-object case) but writing a real JSON array is
    # less surprising for anyone who opens the file by hand.
    ConvertTo-Json -InputObject $manifest -Depth 5 | Out-File -Encoding utf8 $CALIBR_DOWNLOADS
}

function Test-DownloadedByCalibr {
    # Returns $true iff the given absolute path is recorded in the download
    # manifest. Paths are compared case-insensitively to match Windows
    # filesystem semantics.
    param([Parameter(Mandatory)][string]$Path)
    $manifest = @(Get-DownloadManifest)
    if ($manifest.Count -eq 0) { return $false }
    foreach ($e in $manifest) {
        if ($e -and $e.model_path -and $e.model_path -ieq $Path) { return $true }
    }
    return $false
}

function Format-HumanSize {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    return "$bytes bytes"
}

function Get-SampleDestination {
    param($sample, $cfg)
    # Priority: -Destination flag > scan_paths[0] > ./downloaded-models
    $root = if ($Destination) { $Destination }
            elseif ($cfg.scan_paths -and $cfg.scan_paths.Count -gt 0) { $cfg.scan_paths[0] }
            else { Join-Path $CALIBR_ROOT "downloaded-models" }
    return (Join-Path $root $sample.target_dir)
}

function Invoke-HFDownload {
    # Downloads a single file from HuggingFace via Invoke-WebRequest.
    # Returns $true on success/skip, $false on failure.
    param(
        [string]$Repo,
        [string]$File,
        [string]$DestPath,
        [long]$ExpectedBytes = 0
    )
    $url = "https://huggingface.co/$Repo/resolve/main/$File"
    $destDir = Split-Path $DestPath -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

    if ((Test-Path $DestPath) -and (-not $Force)) {
        $actual = (Get-Item $DestPath).Length
        if ($ExpectedBytes -gt 0 -and $actual -eq $ExpectedBytes) {
            Write-Host ("  [skip] already present: $DestPath ({0})" -f (Format-HumanSize $actual)) -ForegroundColor DarkGray
            return $true
        }
        if ($ExpectedBytes -eq 0) {
            Write-Host ("  [skip] already present: $DestPath ({0})" -f (Format-HumanSize $actual)) -ForegroundColor DarkGray
            return $true
        }
        Write-Host ("  [resume] partial file at $DestPath ({0}/{1}); -Force to restart" -f (Format-HumanSize $actual), (Format-HumanSize $ExpectedBytes)) -ForegroundColor Yellow
    }

    Write-Host "  [download] $url" -ForegroundColor Cyan
    Write-Host "             -> $DestPath"
    try {
        # Use BITS if available (resumable, foreground), else fall back to Invoke-WebRequest
        $progressPref = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'  # WebRequest progress is painfully slow in PS 5.1
        Invoke-WebRequest -Uri $url -OutFile $DestPath -ErrorAction Stop -UseBasicParsing
        $ProgressPreference = $progressPref

        $got = (Get-Item $DestPath).Length
        Write-Host ("  [done]  {0}" -f (Format-HumanSize $got)) -ForegroundColor Green
        return $true
    } catch {
        Write-Host ("  [FAIL]  {0}" -f $_.Exception.Message) -ForegroundColor Red
        # Clean up partial file if completely empty
        if ((Test-Path $DestPath) -and (Get-Item $DestPath).Length -eq 0) {
            Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
        }
        return $false
    }
}

function Invoke-GetSampleModels {
    $cfg = Get-Config
    $samples = Get-SampleList

    # Filter by -Model or -SampleId if provided
    $filtered = $samples
    if ($SampleId)  { $filtered = $filtered | Where-Object { $_.id -like $SampleId } }
    if ($Model)    { $filtered = $filtered | Where-Object { $_.model -match $Model } }

    Write-Host "=== get-sample-models ===" -ForegroundColor Cyan
    Write-Host ("Samples catalog: {0} entries" -f $samples.Count)
    if ($Model -or $SampleId) {
        Write-Host ("Filtered: {0} matching" -f @($filtered).Count)
    }
    Write-Host ""

    # Always print the table first
    $fmt = "  {0,-2} {1,-24} {2,-30} {3,-14} {4,10}  {5}"
    Write-Host ($fmt -f "", "ID", "Model", "Variant", "Size", "HF repo") -ForegroundColor White
    Write-Host ($fmt -f "", ("-"*24), ("-"*30), ("-"*14), ("-"*10), ("-"*40)) -ForegroundColor DarkGray
    foreach ($s in $filtered) {
        $dest = Get-SampleDestination -sample $s -cfg $cfg
        $finalPath = Join-Path $dest $s.hf_file
        $status = if (Test-Path $finalPath) { "OK" } else { " " }
        $color = if ($status -eq "OK") { 'Green' } else { 'Gray' }
        $sizeStr = Format-HumanSize ([long]$s.size_bytes)
        Write-Host ($fmt -f $status, $s.id, $s.model, $s.variant, $sizeStr, $s.hf_repo) -ForegroundColor $color
    }

    # Decide what to actually do
    $toDownload = @()
    if ($DownloadAll) {
        $toDownload = @($filtered)
    } elseif ($SampleId -or $Model) {
        $toDownload = @($filtered)
    } else {
        Write-Host "`nNo -SampleId, -Model or -DownloadAll passed: nothing to download. This was a dry listing." -ForegroundColor Yellow
        Write-Host "Examples:" -ForegroundColor Yellow
        Write-Host "  calibr get-sample-models -SampleId qwen3.5-9b-q4km"
        Write-Host "  calibr get-sample-models -Model 'Qwen3.5'"
        Write-Host "  calibr get-sample-models -DownloadAll   # requires confirmation"
        return
    }

    if ($toDownload.Count -eq 0) {
        Write-Host "`nNothing matches filters." -ForegroundColor Yellow
        return
    }

    # Total size warning
    $totalBytes = ($toDownload | Measure-Object -Property size_bytes -Sum).Sum
    $destRoot = if ($Destination) { $Destination }
                elseif ($cfg.scan_paths -and $cfg.scan_paths.Count -gt 0) { $cfg.scan_paths[0] }
                else { Join-Path $CALIBR_ROOT "downloaded-models" }
    Write-Host ("`nAbout to download {0} file(s), total ~{1}." -f $toDownload.Count, (Format-HumanSize $totalBytes)) -ForegroundColor Yellow
    Write-Host "Destination root: $destRoot"

    if ($DryRun) {
        Write-Host "`n[dry-run] not downloading." -ForegroundColor Yellow
        return
    }

    if ($DownloadAll -and -not $NonInteractive) {
        $ok = Read-Host "Proceed? (y/N)"
        if ($ok -notmatch '^[yY]') { Write-Host "Cancelled."; return }
    }

    # Download
    $okCount = 0; $failCount = 0
    foreach ($s in $toDownload) {
        Write-Host ("`n[{0}] {1} ({2})" -f $s.id, $s.model, (Format-HumanSize ([long]$s.size_bytes))) -ForegroundColor Cyan
        $dest = Get-SampleDestination -sample $s -cfg $cfg
        $modelPath = Join-Path $dest $s.hf_file
        # Remember whether the file was already there before the call. If
        # Invoke-HFDownload returns OK because the file existed, we treat it
        # as user-owned and skip the manifest tag — rotation must never
        # delete files calibr didn't actually fetch.
        $modelExistedBefore = Test-Path -LiteralPath $modelPath
        $ok = Invoke-HFDownload -Repo $s.hf_repo -File $s.hf_file -DestPath $modelPath -ExpectedBytes ([long]$s.size_bytes)
        if ($ok) { $okCount++ } else { $failCount++ }

        # mmproj if present
        $mmPath = $null
        if ($ok -and $s.mmproj_file) {
            $mmPath = Join-Path $dest $s.mmproj_file
            Invoke-HFDownload -Repo $s.hf_repo -File $s.mmproj_file -DestPath $mmPath -ExpectedBytes 0 | Out-Null
        }

        # Record in the download manifest only when we actually fetched the
        # file in this call (it didn't already exist). This guarantees that
        # files the user pre-downloaded — even into the same curated path
        # samples.json points to — are never tagged calibr-owned and never
        # rotated.
        if ($ok -and -not $modelExistedBefore) {
            $modelAbs = (Get-Item -LiteralPath $modelPath).FullName
            $mmAbs = if ($mmPath -and (Test-Path $mmPath)) { (Get-Item -LiteralPath $mmPath).FullName } else { "" }
            Add-DownloadManifestEntry -SampleId $s.id -Model $s.model -ModelPath $modelAbs -MmprojPath $mmAbs -SizeBytes ([long]$s.size_bytes)
        }
    }

    Write-Host ""
    if ($failCount -eq 0) {
        Write-Host "[$okCount OK / $failCount FAIL] Done. Run 'calibr discover' to include them." -ForegroundColor Green
    } else {
        Write-Host "[$okCount OK / $failCount FAIL] Some downloads failed. Possible causes:" -ForegroundColor Yellow
        Write-Host "  - Repo moved or file renamed on HuggingFace -> edit samples.json"
        Write-Host "  - Model requires accepting a license (Gemma) -> log into HF and accept, then retry"
        Write-Host "  - Network issue -> retry, or use 'huggingface-cli download' manually"
    }
}

# ============================================================================
# SUBCOMMAND: status
# ============================================================================
function Invoke-Status {
    $cfg = Get-Config
    Write-Host "=== status ===" -ForegroundColor Cyan
    Write-Host "Config:"
    Write-Host "  llama_server_exe = $($cfg.llama_server_exe)"
    Write-Host "  scan_paths       = $($cfg.scan_paths -join ', ')"
    Write-Host "  vram_budget      = $($cfg.hardware.vram_safety_budget_mib) / $($cfg.hardware.vram_total_mib) MiB"
    $catN = if (Test-Path $CALIBR_CATALOG) { (Get-Content $CALIBR_CATALOG -Raw | ConvertFrom-Json).Count } else { 0 }
    $planN = if (Test-Path $CALIBR_PLAN) { (Get-Content $CALIBR_PLAN -Raw | ConvertFrom-Json).Count } else { 0 }
    $resN = (Get-ChildItem $CALIBR_RESULTS_DIR -Filter "*.json" -ErrorAction SilentlyContinue).Count
    Write-Host "State:"
    Write-Host "  catalog: $catN models"
    Write-Host "  plan:    $planN configs"
    Write-Host "  results: $resN completed"
    Write-Host "  report:  $(if (Test-Path $CALIBR_REPORT) { 'yes' } else { 'no' })"
    Write-Host "Install:"
    $installed = (Test-LlmLabInstalled)
    Write-Host "  global PATH: $(if ($installed) { 'yes (User scope)' } else { 'no  (run: calibr install)' })"
}

# ============================================================================
# SUBCOMMAND: install / uninstall (manage User PATH so `calibr` works globally)
# ============================================================================
function Test-LlmLabInstalled {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if (-not $userPath) { return $false }
    $entries = $userPath -split ';' | Where-Object { $_ }
    return ($entries -contains $CALIBR_ROOT)
}

function Invoke-Install {
    Write-Host "=== install ===" -ForegroundColor Cyan
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $entries = if ($userPath) { @($userPath -split ';' | Where-Object { $_ }) } else { @() }

    if ($entries -contains $CALIBR_ROOT) {
        Write-Host "Already installed: '$CALIBR_ROOT' is on User PATH." -ForegroundColor DarkGray
        return
    }

    $newEntries = $entries + $CALIBR_ROOT
    [Environment]::SetEnvironmentVariable("PATH", ($newEntries -join ';'), "User")
    Write-Host "Added '$CALIBR_ROOT' to User PATH." -ForegroundColor Green

    # Update the current shell session too, so the user can immediately type `calibr`.
    if (-not (($env:PATH -split ';') -contains $CALIBR_ROOT)) {
        $env:PATH = "$env:PATH;$CALIBR_ROOT"
        Write-Host "(also patched this session's PATH; new terminals will pick it up automatically.)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "You can now run 'calibr <command>' from any directory." -ForegroundColor Cyan
    Write-Host "Try:  calibr status"
}

function Invoke-Uninstall {
    Write-Host "=== uninstall ===" -ForegroundColor Cyan
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $entries = if ($userPath) { @($userPath -split ';' | Where-Object { $_ }) } else { @() }

    if ($entries -notcontains $CALIBR_ROOT) {
        Write-Host "Not installed: '$CALIBR_ROOT' is not on User PATH." -ForegroundColor DarkGray
        return
    }

    $newEntries = @($entries | Where-Object { $_ -ne $CALIBR_ROOT })
    [Environment]::SetEnvironmentVariable("PATH", ($newEntries -join ';'), "User")
    Write-Host "Removed '$CALIBR_ROOT' from User PATH." -ForegroundColor Green

    if (($env:PATH -split ';') -contains $CALIBR_ROOT) {
        $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -ne $CALIBR_ROOT }) -join ';'
        Write-Host "(also patched this session's PATH.)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "Open a new terminal for the change to apply globally." -ForegroundColor DarkGray
    Write-Host "From the project directory you can still use: .\calibr.ps1 <command>"
}

# ============================================================================
# SUBCOMMAND: config (list / get / set / unset)
# ============================================================================
function Get-NestedValue {
    # Walk a hashtable along a dot-path. Returns @{ found=$bool; value=$any }.
    param($obj, [string]$path)
    $parts = $path -split '\.'
    $cur = $obj
    foreach ($p in $parts) {
        if ($cur -is [hashtable] -and $cur.ContainsKey($p)) { $cur = $cur[$p] }
        else { return @{ found=$false; value=$null } }
    }
    return @{ found=$true; value=$cur }
}

function Set-NestedValue {
    # Set a value at a dot-path, creating intermediate hashtables as needed.
    param($obj, [string]$path, $value)
    $parts = $path -split '\.'
    $cur = $obj
    for ($i=0; $i -lt $parts.Count - 1; $i++) {
        if (-not ($cur -is [hashtable])) { throw "cannot descend into non-object at '$($parts[0..$i] -join '.')'" }
        if (-not $cur.ContainsKey($parts[$i])) { $cur[$parts[$i]] = @{} }
        $cur = $cur[$parts[$i]]
    }
    if (-not ($cur -is [hashtable])) { throw "cannot set leaf on non-object" }
    $cur[$parts[-1]] = $value
}

function Remove-NestedValue {
    # Remove a key at a dot-path. Returns $true if removed, $false if not present.
    # After removing the leaf, walks back up the chain and prunes any parent
    # hashtable that became empty as a result, stopping as soon as we find a
    # parent that still has siblings. Avoids leaving carcasses like `bench:{}`
    # in config.json after an unset.
    param($obj, [string]$path)
    $parts = $path -split '\.'

    $stack = @()
    $cur = $obj
    for ($i=0; $i -lt $parts.Count - 1; $i++) {
        if (-not ($cur -is [hashtable]) -or -not $cur.ContainsKey($parts[$i])) { return $false }
        $stack += ,@($cur, $parts[$i])
        $cur = $cur[$parts[$i]]
    }
    if (-not ($cur -is [hashtable]) -or -not $cur.ContainsKey($parts[-1])) { return $false }
    $cur.Remove($parts[-1])

    for ($i = $stack.Count - 1; $i -ge 0; $i--) {
        $parent = $stack[$i][0]
        $key    = $stack[$i][1]
        if ($parent[$key] -is [hashtable] -and $parent[$key].Count -eq 0) {
            $parent.Remove($key)
        } else {
            break
        }
    }
    return $true
}

function Get-FlatConfig {
    # Emit (Key, Value) rows with dot-notation paths, skipping _comment_* keys.
    # Stream-style: each PSCustomObject flows to the pipeline directly so callers
    # can either pipe them through ForEach-Object or collect with @(...).
    param($obj, [string]$prefix = "")
    foreach ($k in ($obj.Keys | Sort-Object)) {
        if ($k -match '^_comment') { continue }
        $key = if ($prefix) { "$prefix.$k" } else { $k }
        $v = $obj[$k]
        if ($v -is [hashtable]) {
            Get-FlatConfig -obj $v -prefix $key
        } else {
            [PSCustomObject]@{ Key=$key; Value=$v }
        }
    }
}

function Get-RuntimeType {
    # Type of the actual value (used for display in list/get).
    param($v)
    if ($null -eq $v)                                          { return "null"   }
    if ($v -is [bool])                                         { return "bool"   }
    if ($v -is [int] -or $v -is [long])                        { return "int"    }
    if ($v -is [double] -or $v -is [single] -or $v -is [decimal]) { return "float" }
    if ($v -is [array])                                        { return "array"  }
    if ($v -is [hashtable])                                    { return "object" }
    return "string"
}

function Get-ConfigValueType {
    # Type from the default schema (used by set to know how to parse the input).
    # Returns "null" when the schema has a null placeholder; "unknown" if the key
    # doesn't exist in the schema at all.
    param($defaultCfg, [string]$path)
    $r = Get-NestedValue -obj $defaultCfg -path $path
    if (-not $r.found) { return "unknown" }
    return Get-RuntimeType -v $r.value
}

function Convert-ConfigValueString {
    # Parse a CLI string into the right type for writing into config.json.
    # When the schema type is "null" (placeholder in default), guess from the value shape.
    param([string]$valueStr, [string]$type)
    switch ($type) {
        "bool" {
            if ($valueStr -match '^(true|1|yes|on)$')  { return $true }
            if ($valueStr -match '^(false|0|no|off)$') { return $false }
            throw "expected bool (true/false/1/0/yes/no/on/off); got '$valueStr'"
        }
        "int"   { return [int]$valueStr }
        "float" { return [double]$valueStr }
        "array" { return @($valueStr -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
        "object" { throw "cannot set an entire object; set its leaf keys individually" }
        "null" {
            if ($valueStr -match '^(true|false)$')   { return [bool]::Parse($valueStr) }
            if ($valueStr -match '^-?\d+$')          { return [int]$valueStr }
            if ($valueStr -match '^-?\d+\.\d+$')     { return [double]$valueStr }
            return $valueStr
        }
        default { return $valueStr }
    }
}

function Format-ConfigValue {
    param($v)
    if ($null -eq $v)   { return "(null)" }
    if ($v -is [bool])  { return $v.ToString().ToLower() }
    if ($v -is [array]) {
        if ($v.Count -eq 0) { return "[]" }
        $items = @($v | ForEach-Object {
            if ($_ -is [hashtable]) { "{...}" }
            elseif ($_ -is [string]) { '"' + $_ + '"' }
            elseif ($_ -is [bool]) { $_.ToString().ToLower() }
            else { [string]$_ }
        })
        return "[" + ($items -join ', ') + "]"
    }
    if ($v -is [hashtable]) { return "{...}" }
    return [string]$v
}

function Show-ConfigUsage {
    Write-Host "Usage: calibr config <action> [<key>] [<value>]"
    Write-Host ""
    Write-Host "Actions:" -ForegroundColor White
    Write-Host "  list                 Print all keys with type + source ([default] / [local])"
    Write-Host "  get <key>            Print one value (or sub-keys for an object)"
    Write-Host "  set <key> <value>    Write a leaf value to config.json (override default)"
    Write-Host "  unset <key>          Remove the local override (default applies again)"
    Write-Host "  detect [<key>]       Auto-detect a value (interactive picker for ambiguous matches)"
    Write-Host "                       Supported keys: llama_server_exe, hardware, all (default: all)"
    Write-Host ""
    Write-Host "Run 'calibr help config' for examples and details."
}

function Invoke-ConfigDetect {
    # Re-runs the same detection logic as `init` but writes only the requested key
    # to the local config. Returns $true on a successful write, $false otherwise.
    param([string]$keyName, $localCfg, $defaultCfg)

    switch ($keyName) {
        "llama_server_exe" {
            Write-Host "Searching for llama-server.exe..." -ForegroundColor Cyan
            $exes = @(Find-LlamaServerExe)
            if ($exes.Count -eq 0) {
                Write-Host "  No candidates found. Set manually with: calibr config set llama_server_exe `"<path>`"" -ForegroundColor Yellow
                return $false
            }
            $picked = $null
            if ($exes.Count -eq 1) {
                $picked = $exes[0]
                Write-Host "  Found single candidate: $picked" -ForegroundColor Green
            } else {
                Write-Host "  Multiple candidates:" -ForegroundColor Yellow
                for ($i=0; $i -lt $exes.Count; $i++) { Write-Host "    [$i] $($exes[$i])" }
                if ($NonInteractive) {
                    $picked = $exes[0]
                    Write-Host "  Picked [0] (non-interactive). Re-run with -NonInteractive:`$false to choose."
                } else {
                    $idx = Read-Host "  Pick index [0]"
                    if (-not $idx) { $idx = 0 }
                    $picked = $exes[[int]$idx]
                }
            }
            $localCfg["llama_server_exe"] = $picked
            Write-Host "  Set llama_server_exe = $picked" -ForegroundColor Green
            return $true
        }
        "hardware" {
            Write-Host "Detecting hardware..." -ForegroundColor Cyan
            $hw = Get-DetectedHardware
            if ($hw.gpu_name) {
                Write-Host "  GPU: $($hw.gpu_name), $($hw.vram_total_mib) MiB VRAM, compute $($hw.gpu_compute_cap)" -ForegroundColor Green
            } else {
                Write-Host "  nvidia-smi not available or no NVIDIA GPU detected. Set hardware.* keys manually." -ForegroundColor Yellow
                return $false
            }
            if ($hw.cpu_cores_physical) {
                Write-Host "  CPU: $($hw.cpu_cores_physical)C/$($hw.cpu_threads_logical)T" -ForegroundColor Green
            }

            $pct = if ($defaultCfg.hardware.vram_safety_budget_pct) { $defaultCfg.hardware.vram_safety_budget_pct } else { 0.95 }
            if (-not ($localCfg["hardware"] -is [hashtable])) { $localCfg["hardware"] = @{} }
            $h = $localCfg["hardware"]
            $h["auto_detect"] = $false
            if ($hw.vram_total_mib) {
                $h["vram_total_mib"]         = $hw.vram_total_mib
                $h["vram_safety_budget_mib"] = [int]($hw.vram_total_mib * $pct)
            }
            if ($hw.gpu_name)            { $h["gpu_name"]            = $hw.gpu_name }
            if ($hw.gpu_compute_cap)     { $h["gpu_compute_cap"]     = $hw.gpu_compute_cap }
            if ($hw.cpu_cores_physical)  { $h["cpu_cores_physical"]  = $hw.cpu_cores_physical }
            if ($hw.cpu_threads_logical) { $h["cpu_threads_logical"] = $hw.cpu_threads_logical }
            return $true
        }
        default {
            Write-Host "Unknown detect key '$keyName'. Supported: llama_server_exe, hardware, all" -ForegroundColor Yellow
            return $false
        }
    }
}

function Invoke-Config {
    if (-not $Action) { Show-ConfigUsage; return }
    $act = $Action.ToLower()

    $defRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $defaultCfg = ConvertTo-Hashtable -obj $defRaw
    $effective  = Get-Config

    $localCfg = @{}
    if (Test-Path $CALIBR_LOCAL_CFG) {
        $locRaw = Get-Content $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
        $localCfg = ConvertTo-Hashtable -obj $locRaw
    }

    switch ($act) {
        "list" {
            $rows = @(Get-FlatConfig -obj $effective)
            $maxKey = ($rows | ForEach-Object { $_.Key.Length } | Measure-Object -Maximum).Maximum
            $localLabel = if (Test-Path $CALIBR_LOCAL_CFG) { Split-Path $CALIBR_LOCAL_CFG -Leaf } else { "(no local override)" }
            Write-Host ("=== config (effective: default <- {0}) ===" -f $localLabel) -ForegroundColor Cyan
            foreach ($r in $rows) {
                $type   = Get-RuntimeType -v $r.Value
                $localR = Get-NestedValue -obj $localCfg -path $r.Key
                $marker = if ($localR.found) { "[local]" } else { "[default]" }
                $color  = if ($localR.found) { 'Green' } else { 'Gray' }
                $line   = "  {0,-$maxKey}  {1,-8}  {2,-9}  {3}" -f $r.Key, "($type)", $marker, (Format-ConfigValue $r.Value)
                Write-Host $line -ForegroundColor $color
            }
        }
        "get" {
            if (-not $Key) { throw "config get requires a key. Try 'calibr config list'." }
            $r = Get-NestedValue -obj $effective -path $Key
            if (-not $r.found) { Write-Host "key '$Key' not found." -ForegroundColor Yellow; return }
            $type   = Get-RuntimeType -v $r.value
            $localR = Get-NestedValue -obj $localCfg -path $Key
            $source = if ($localR.found) { "[local]" } else { "[default]" }
            if ($r.value -is [hashtable]) {
                Write-Host "$Key (object) $source" -ForegroundColor Cyan
                Get-FlatConfig -obj $r.value -prefix $Key | ForEach-Object {
                    $t = Get-RuntimeType -v $_.Value
                    Write-Host ("  {0}  ({1})  = {2}" -f $_.Key, $t, (Format-ConfigValue $_.Value))
                }
            } else {
                Write-Host ("{0} = {1}  ({2}) {3}" -f $Key, (Format-ConfigValue $r.value), $type, $source) -ForegroundColor Cyan
            }
        }
        "set" {
            if (-not $Key)        { throw "config set requires a key. e.g. config set hardware.vram_total_mib 8192" }
            if ($null -eq $Value) { throw "config set requires a value." }
            $type = Get-ConfigValueType -defaultCfg $defaultCfg -path $Key
            if ($type -eq "unknown") { throw "key '$Key' is not in config.default.json. Edit the file directly to add new keys." }
            if ($type -eq "object")  { throw "'$Key' is an object; set its leaf keys individually." }
            $converted = Convert-ConfigValueString -valueStr $Value -type $type
            Set-NestedValue -obj $localCfg -path $Key -value $converted
            $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
            Write-Host ("set {0} = {1}  ({2}) -> {3}" -f $Key, (Format-ConfigValue $converted), $type, (Split-Path $CALIBR_LOCAL_CFG -Leaf)) -ForegroundColor Green
        }
        "unset" {
            if (-not $Key) { throw "config unset requires a key." }
            if (-not (Test-Path $CALIBR_LOCAL_CFG)) {
                Write-Host "no local config.json present; nothing to unset." -ForegroundColor Yellow
                return
            }
            $removed = Remove-NestedValue -obj $localCfg -path $Key
            if ($removed) {
                $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
                Write-Host "unset $Key  (default value applies on next run)" -ForegroundColor Green
            } else {
                Write-Host "key '$Key' was not in $(Split-Path $CALIBR_LOCAL_CFG -Leaf); nothing to do." -ForegroundColor Yellow
            }
        }
        "detect" {
            $target = if ($Key) { $Key.ToLower() } else { "all" }
            $any = $false
            if ($target -eq "all") {
                $r1 = Invoke-ConfigDetect -keyName "llama_server_exe" -localCfg $localCfg -defaultCfg $defaultCfg
                Write-Host ""
                $r2 = Invoke-ConfigDetect -keyName "hardware" -localCfg $localCfg -defaultCfg $defaultCfg
                $any = ($r1 -or $r2)
            } else {
                $any = Invoke-ConfigDetect -keyName $target -localCfg $localCfg -defaultCfg $defaultCfg
            }
            if ($any) {
                $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
                Write-Host ""
                Write-Host "Saved -> $(Split-Path $CALIBR_LOCAL_CFG -Leaf)" -ForegroundColor Green
            } else {
                Write-Host ""
                Write-Host "Nothing detected; config.json unchanged." -ForegroundColor DarkGray
            }
        }
        default {
            Write-Host "Unknown config action '$Action'." -ForegroundColor Yellow
            Write-Host ""
            Show-ConfigUsage
        }
    }
}

# ============================================================================
# SUBCOMMAND: help
# ============================================================================
function Invoke-Help {
    $cmds = [ordered]@{
        "init"              = "Detect HW + write config.json (interactive or -NonInteractive)."
        "discover"          = "Scan scan_paths for .gguf, write data/catalog.json."
        "plan"              = "Expand the catalog into a sweep of test configs (data/plan.json)."
        "bench"             = "Run pending tests against llama-server, save data/results/*.json."
        "report"            = "Build data/report.html and data/bats/{model}.bat per winner."
        "all"               = "discover + plan + bench + report (optionally + download samples)."
        "status"            = "Show config + counts (catalog/plan/results) + global-install state."
        "config"            = "Get / set / list / unset config values from CLI."
        "get-sample-models" = "List or download curated reference GGUFs from HuggingFace."
        "install"           = "Add this directory to user PATH so 'calibr' works globally."
        "uninstall"         = "Remove this directory from user PATH."
        "help"              = "This screen, or 'help <command>' for details."
    }

    $details = @{
        "init" = @{
            Usage    = "calibr init [-LlamaServer <path>] [-ScanPath <paths>] [-Force] [-NonInteractive]"
            Flags    = @(
                "-LlamaServer <path>   Pre-fill llama_server_exe instead of auto-detecting"
                "-ScanPath <paths>     Pre-fill scan_paths (comma-separated or repeated)"
                "-Force                Overwrite an existing config.json"
                "-NonInteractive       Pick the first auto-detected option, no prompts"
            )
            Examples = @( "calibr init", "calibr init -ScanPath D:\models -Force" )
        }
        "discover" = @{
            Usage    = "calibr discover [-ScanPath <paths>] [-ExcludePattern <patterns>]"
            Flags    = @(
                "-ScanPath <paths>           Scan these instead of config.scan_paths"
                "-ExcludePattern <patterns>  Skip files matching these wildcards (added to defaults)"
            )
            Examples = @( "calibr discover", "calibr discover -ScanPath D:\models" )
        }
        "plan" = @{
            Usage    = "calibr plan [-Model <regex>] [-Tier {A,B,C}] [-DryRun]"
            Flags    = @(
                "-Model <regex>    Only plan models whose name matches"
                "-Tier {A|B|C}     Only plan tests for the selected tier"
                "-DryRun           Print what would be planned, don't write plan.json"
            )
            Examples = @( "calibr plan", "calibr plan -Model Qwen3.5 -DryRun" )
        }
        "bench" = @{
            Usage    = "calibr bench [-Model <regex>] [-Tier {A,B,C}] [-Id <wildcard>] [-Force] [-DryRun] [-KeepDownloads]"
            Flags    = @(
                "-Model <regex>    Only run configs whose model name matches"
                "-Tier {A|B|C}     Only run configs for this tier"
                "-Id <wildcard>    Only run configs whose test ID matches (e.g. 'T023*')"
                "-Force            Re-run tests whose JSON results already exist"
                "-DryRun           List configs that would run, don't execute"
                "-KeepDownloads    Opt out of post-bench rotation. By default, any model whose"
                "                  .gguf is recorded in data/downloads.json (i.e. calibr"
                "                  downloaded it) is deleted from disk after every config for"
                "                  that model finishes successfully. User-owned files are"
                "                  never touched regardless of this flag."
            )
            Examples = @(
                "calibr bench"
                "calibr bench -Model Qwen3.5-9B"
                "calibr bench -Tier A -Force"
                "calibr bench -KeepDownloads"
            )
        }
        "report" = @{
            Usage    = "calibr report [-GroupBy {model|model+variant}] [-PreferSpeed]"
            Flags    = @(
                "-GroupBy model           (default) one winner per model"
                "-GroupBy model+variant   one winner per (model,variant) pair"
                "-PreferSpeed             Pick highest eval_tps regardless of WDDM paging"
                "                         (default: prefer non-paging configs even if slower)"
            )
            Examples = @( "calibr report", "calibr report -GroupBy model+variant", "calibr report -PreferSpeed" )
        }
        "all" = @{
            Usage    = "calibr all [-DownloadSamples [-SampleId <id>] [-Model <regex>]] [-Force] [-PreferSpeed] [-KeepDownloads]"
            Flags    = @(
                "-DownloadSamples         Interleaved mode: walk samples one-by-one, download"
                "                         -> discover -> plan -> bench -> rotate per sample so"
                "                         peak disk stays bounded to one model. Pre-existing"
                "                         models in scan_paths are benched first (phase 0)."
                "-SampleId <id>           (with -DownloadSamples) only fetch the matching sample"
                "-Model <regex>           Filter download AND bench by model name"
                "-Force                   Re-run all benchmarks (skip cache)"
                "-PreferSpeed             Pick fastest config per model, ignore WDDM safety"
                "-KeepDownloads           Opt out of post-bench rotation. By default with"
                "                         -DownloadSamples, calibr-downloaded files are deleted"
                "                         after a clean bench to bound peak disk to one model."
            )
            Examples = @(
                "calibr all"
                "calibr all -DownloadSamples"
                "calibr all -DownloadSamples -SampleId qwen3.5-9b-q4km"
                "calibr all -DownloadSamples -KeepDownloads"
                "calibr all -PreferSpeed"
            )
        }
        "config" = @{
            Usage    = "calibr config <list|get|set|unset|detect> [<key>] [<value>]"
            Flags    = @(
                "list                       Print all keys with type + source ([default] / [local])"
                "get <key>                  Print one value. Object keys list their sub-keys."
                "set <key> <value>          Write a leaf value to config.json (override)."
                "                           Type is inferred from config.default.json schema."
                "                           Arrays accept CSV: 'D:\models,E:\cache'"
                "                           Bools accept: true/false/1/0/yes/no/on/off"
                "unset <key>                Remove the local override (default applies again)."
                "detect [<key>]             Auto-detect a value (interactive picker if ambiguous)."
                "                           Supported: llama_server_exe, hardware, all (default)."
                "                           Same logic as 'init' but writes only the requested key."
            )
            Examples = @(
                "calibr config list"
                "calibr config get hardware.vram_total_mib"
                "calibr config set hardware.vram_safety_budget_pct 0.92"
                "calibr config set scan_paths 'D:\models,E:\cache'"
                "calibr config unset llama_server_exe"
                "calibr config detect llama_server_exe"
                "calibr config detect hardware"
                "calibr config detect"
            )
        }
        "status" = @{
            Usage    = "calibr status"
            Flags    = @()
            Examples = @( "calibr status" )
        }
        "get-sample-models" = @{
            Usage    = "calibr get-sample-models [-DownloadAll | -SampleId <id> | -Model <regex>] [-Destination <path>] [-DryRun]"
            Flags    = @(
                "(no flag)                  Print catalog as a dry listing"
                "-DownloadAll               Download every sample (asks confirmation, ~100 GB)"
                "-SampleId <id>             Download only the matching sample id"
                "-Model <regex>             Filter samples by model name"
                "-Destination <path>        Override target root (default: scan_paths[0])"
                "-DryRun                    Show what would be downloaded without doing it"
            )
            Examples = @(
                "calibr get-sample-models"
                "calibr get-sample-models -SampleId qwen3.5-9b-q4km"
                "calibr get-sample-models -DownloadAll"
            )
        }
        "install" = @{
            Usage    = "calibr install"
            Flags    = @(
                "(no flags)                 Adds this directory to the User-scope PATH."
                "                           Idempotent. Also patches the current shell session."
                "                           After this, 'calibr <cmd>' works from any directory."
                "                           No admin rights needed (writes only User PATH, not Machine)."
            )
            Examples = @( "calibr install" )
        }
        "uninstall" = @{
            Usage    = "calibr uninstall"
            Flags    = @(
                "(no flags)                 Removes this directory from the User-scope PATH."
                "                           Files in the project remain untouched."
            )
            Examples = @( "calibr uninstall" )
        }
        "help" = @{
            Usage    = "calibr help [<command>]"
            Flags    = @()
            Examples = @( "calibr help", "calibr help bench", "calibr help config" )
        }
    }

    if (-not $Action) {
        Write-Host "calibr - benchmark crawler/tester for llama.cpp on local GGUFs" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Usage: calibr <command> [options]"
        Write-Host ""
        Write-Host "Commands:" -ForegroundColor White
        $w = ($cmds.Keys | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
        foreach ($k in $cmds.Keys) { Write-Host ("  {0,-$w}  {1}" -f $k, $cmds[$k]) }
        Write-Host ""
        Write-Host "Run 'calibr help <command>' for usage details and examples."
        if (-not (Test-LlmLabInstalled)) {
            Write-Host ""
            Write-Host "Note: 'calibr' is not on your PATH yet. Run '.\calibr.ps1 install'" -ForegroundColor DarkYellow
            Write-Host "      once to enable global invocation; until then use '.\calibr.ps1 <cmd>'" -ForegroundColor DarkYellow
            Write-Host "      or '.\calibr.cmd <cmd>' from this directory." -ForegroundColor DarkYellow
        }
        return
    }

    $tgt = $Action.ToLower()
    if (-not $details.ContainsKey($tgt)) {
        Write-Host "Unknown command '$Action'. Run 'calibr help' for the list." -ForegroundColor Yellow
        return
    }

    $d = $details[$tgt]
    Write-Host ("=== {0} ===" -f $tgt) -ForegroundColor Cyan
    Write-Host $cmds[$tgt]
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor White
    Write-Host "  $($d.Usage)"
    if ($d.Flags.Count -gt 0) {
        Write-Host ""
        Write-Host "Flags:" -ForegroundColor White
        foreach ($f in $d.Flags) { Write-Host "  $f" }
    }
    if ($d.Examples.Count -gt 0) {
        Write-Host ""
        Write-Host "Examples:" -ForegroundColor White
        foreach ($e in $d.Examples) { Write-Host "  $e" }
    }
}

# ============================================================================
# DISPATCH
# ============================================================================
# When this script is dot-sourced (e.g. by tests), $MyInvocation.InvocationName
# is the literal '.'. In that case we want all the function definitions above
# to be exported into the caller's scope, but we do NOT want the dispatch
# below to fire — otherwise just dot-sourcing for tests would print the help
# banner (or worse, run an actual subcommand).
if ($MyInvocation.InvocationName -eq '.') { return }

switch ($Command) {
    "init"               { Invoke-Init }
    "discover"           { Invoke-Discover }
    "plan"               { Invoke-Plan }
    "bench"              { Invoke-Bench }
    "report"             { Invoke-Report }
    "status"             { Invoke-Status }
    "config"             { Invoke-Config }
    "help"               { Invoke-Help }
    "install"            { Invoke-Install }
    "uninstall"          { Invoke-Uninstall }
    "get-sample-models"  { Invoke-GetSampleModels }
    "all"                {
        if ($DownloadSamples) {
            # Interleaved rotation: instead of fetching the entire curated set
            # up-front (~88 GB peak) and benching afterwards, we walk one
            # sample at a time — download → discover → plan → bench just this
            # model → rotation deletes it — so the working set on disk stays
            # bounded to one model. This is what makes -KeepDownloads=off
            # actually deliver the 'peak ~ largest single file' promise the
            # CLI's pre-flight gate shows.
            $samples = Get-SampleList
            if ($SampleId) { $samples = $samples | Where-Object { $_.id -like $SampleId } }
            if ($Model)    { $samples = $samples | Where-Object { $_.model -match $Model } }
            $samples = @($samples)
            if ($samples.Count -eq 0) {
                Write-Host "No samples match the current -SampleId / -Model filters. Nothing to do." -ForegroundColor Yellow
                return
            }

            # Point scan_paths at the download destination if the user hasn't
            # configured it; otherwise discover would later throw 'scan_paths
            # is empty'.
            $cfgInit = Get-Config
            $scanEmpty = (-not $cfgInit.scan_paths -or $cfgInit.scan_paths.Count -eq 0)
            $cliEmpty  = (-not $script:ScanPath  -or $script:ScanPath.Count  -eq 0)
            if ($scanEmpty -and $cliEmpty) {
                $defaultDl = if ($Destination) { $Destination } else { Join-Path $CALIBR_ROOT "downloaded-models" }
                $script:ScanPath = @($defaultDl)
                Write-Host "[all] No scan_paths configured. Will scan $defaultDl." -ForegroundColor Cyan
            }

            Write-Host ""
            Write-Host ("=== all -DownloadSamples : {0} sample(s), rotated ===" -f $samples.Count) -ForegroundColor Cyan

            # Phase 0: bench whatever is already on disk so existing models
            # don't get orphaned by the per-sample loop (each iteration's
            # bench is narrowed to the current sample's model). Skipped if
            # the user explicitly scoped with -SampleId or -Model — then
            # they want a narrow run, not a sweep over everything.
            if (-not $SampleId -and -not $Model) {
                Write-Host ""
                Write-Host "--- pre-existing models ---" -ForegroundColor DarkCyan
                Invoke-Discover
                Invoke-Plan
                Invoke-Bench
            }

            # Phase 1+: per-sample download + bench + rotate.
            $savedSampleId = $script:SampleId
            $savedModel    = $script:Model
            $idx = 0
            foreach ($s in $samples) {
                $idx++
                Write-Host ""
                # Two prefixes: the bracketed [sample X/N] is CLI-parseable
                # (RunView surfaces it as the outer progress strip); the
                # second line is human-readable.
                Write-Host ("[sample {0}/{1}] {2}" -f $idx, $samples.Count, $s.id)
                Write-Host ("--- sample {0}/{1} : {2} ({3}) ---" -f $idx, $samples.Count, $s.id, $s.model) -ForegroundColor Cyan

                $script:SampleId = $s.id
                $script:Model    = ""   # SampleId narrows enough on its own
                Invoke-GetSampleModels

                # Re-discover so the freshly-downloaded file enters the catalog;
                # re-plan because the catalog grew.
                $script:SampleId = $savedSampleId
                Invoke-Discover
                Invoke-Plan

                # Bench narrows to this sample's model — Invoke-RotationCheck
                # then has a chance to delete the .gguf the moment its last
                # config finishes successfully.
                $script:Model = $s.model
                Invoke-Bench
            }
            $script:SampleId = $savedSampleId
            $script:Model    = $savedModel

            Write-Host ""
            Write-Host "--- final report ---" -ForegroundColor DarkCyan
            Invoke-Report
        } else {
            Invoke-Discover; Invoke-Plan; Invoke-Bench; Invoke-Report
        }
    }
    default              { Invoke-Help }
}

# Some native commands we shell out to (notably nvidia-smi on certain driver
# builds) leave $LASTEXITCODE non-zero even on success, which then propagates
# to the caller as a misleading non-zero exit. If we made it here without an
# uncaught exception, the user-visible task succeeded — exit clean.
$global:LASTEXITCODE = 0
exit 0
