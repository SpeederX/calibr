#Requires -Version 5.1
<#
.SYNOPSIS
    calibr -- crawler/tester for GGUF models via llama.cpp

.DESCRIPTION
    Discovers GGUF models in configured paths, assigns curated hardware levels,
    generates and runs a benchmark plan with WDDM-paging detection on Windows,
    and emits an HTML report plus per-model .bat launchers.

.EXAMPLE
    calibr init                     # first-time setup: detect HW, write config.json
    calibr discover                 # scan for .gguf files
    calibr plan                     # generate test plan
    calibr bench -Level low         # run only low-level benchmarks
    calibr bench -Model Qwen3.5-9B  # run only this model
    calibr report                   # build HTML + .bat
    calibr all                      # full pipeline (works on whatever .gguf are on disk)
    calibr all -FetchCatalog     # fetch curated catalog first, then run the pipeline
    calibr all -FetchCatalog -CatalogId qwen3.5-9b-q4km   # only one entry (~5 GB)

    # One-shot without editing config.json (useful for CI / try-and-throw-away):
    calibr discover -ScanPath "D:\models","E:\llm-cache"
    calibr all -ScanPath "C:\foo" -LlamaServer "C:\bin\llama-server.exe"

.NOTES
    Project: https://github.com/<OWNER>/calibr  (update after publishing)
#>

[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet("init","discover","plan","bench","report","all","status","help","get-models","config","install","uninstall","reset","doctor","")]
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
    [ValidateSet("", "low", "middle", "high", "ultra")][string]$Level = "",
    [string]$Id = "",
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NonInteractive,

    # Used by plan/bench/all: restrict the context sweep to these ctx sizes
    # (CSV, e.g. "16384,32768"). Overrides config.context_candidates. Drives
    # CustomBenchView v2's ctx-checkbox selection.
    [string]$ContextSizes = "",

    # Optional diagnostic workload curves. Baseline is always included;
    # prefill/KV-fill profiles are added on the largest valid context config.
    [ValidateSet("baseline", "prefill", "kv-fill", "all")]
    [string]$WorkloadSweep = "baseline",

    # CLI overrides for config fields. These take priority over config.json.
    # Used by: discover (ScanPath, ExcludePattern), bench/report (LlamaServer), all (all of them), init (pre-fills instead of auto-detecting).
    [string[]]$ScanPath = @(),
    [string]$LlamaServer = "",
    [switch]$AutoFetchLlama,         # init/all: download an official llama.cpp build when llama-server is missing
    [string]$LlamaCppBuild = "",     # init/all with -AutoFetchLlama: bNNNN release tag (empty = latest)
    [string[]]$ExcludePattern = @(),

    # Used by get-models
    [string]$CatalogId = "",         # download only the matching catalog entry id
    [switch]$DownloadAll,            # download every entry matching filters (prompts for confirmation)
    [switch]$FetchCatalog,           # `all` only: fetch curated models before running the pipeline
    [string]$Destination = "",       # override target root (default: scan_paths[0])
    [string]$Preset = "",            # named preset from default_bench_presets.json / data/user_bench_presets.json

    # Disables the extended metric polling during bench (GPU power/temp/util,
    # system RAM, disk I/O, and the [poll] emit consumed by the CLI live
    # strip). Reduces polling-thread overhead from ~1-3% CPU to under 1%.
    # The result JSON keeps the extended metric FIELDS but they all read 0
    # / null. Useful when you want the cleanest possible bench numbers and
    # don't need real-time visibility.
    [switch]$MinimalPolling,

    # Used by report: how to group results when selecting winners
    [ValidateSet("model", "model+variant")]
    [string]$GroupBy = "model",

    # Used by report (and `all`): pick the highest-eval_tps config per group,
    # ignoring WDDM-paging safety. Default off - safety wins ties.
    [switch]$PreferSpeed,

    # Used by report (and `all`): warn when baseline VRAM already used by
    # OS/apps before each config run is at or above this percentage. -1 means
    # use preferences.vram_usage_warning_pct from config (default 10).
    [int]$VramUsageWarningPct = -1,

    # Used by bench (and `all`): how many runs to execute per config when
    # gathering measurements. The top-level result records the median over the
    # N runs for varying metrics; raw per-run values live in a `runs` array.
    # 0 means "use bench.runs_per_config from config" (default 3).
    [int]$Runs = 0,

    # Used by bench (and `all`): what to do with models downloaded during the
    # current run. cleanup deletes each calibr-downloaded model after its bench;
    # keep-all keeps them in the model folder; keep-top-1/3 keeps only the best
    # current winners according to the same winner rule as the report. User-owned
    # files (those not in the download manifest) are never touched.
    [ValidateSet("cleanup", "keep-all", "keep-top-3", "keep-top-1")]
    [string]$DownloadRetention = "cleanup",

    # Legacy alias for old scripts. Prefer -DownloadRetention keep-all.
    [switch]$KeepDownloads,

    # Used by 'reset': pick which buckets of runtime state to wipe. Each
    # flag is opt-in (default is no-op). -All toggles every bucket on.
    # User-owned files in scan_paths are NEVER touched by reset; only the
    # downloaded models tracked in data/downloads.json can be wiped, and
    # only when -DownloadedModels is set.
    [switch]$Results,           # data/results/*.json
    [switch]$Catalog,           # data/catalog.json
    [switch]$Plan,              # data/plan.json
    [switch]$Report,            # data/report.html
    [switch]$Logs,              # data/logs/*.log
    [switch]$Bats,              # data/bats/*.bat
    [switch]$Downloads,         # data/downloads.json (manifest only, not the files)
    [switch]$DownloadedModels,  # the actual .gguf + mmproj listed in the manifest
    [switch]$LocalConfig,       # config.json (the user's local override)
    [switch]$All,               # convenience: all of the above

    # Used by 'doctor': -Extended keeps full (uncapped) command logs in the
    # bundle; -Json prints the diagnostic contract to stdout (consumed by the
    # CLI); -Export writes it to a file (default data/doctor-report.json),
    # -ExportPath overrides the destination.
    [switch]$Extended,
    [switch]$Json,
    [switch]$Export,
    [string]$ExportPath = ""
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
$script:CALIBR_REPORTS_DIR = Join-Path $CALIBR_DATA_DIR "reports"   # archived old reports
$script:CALIBR_CALIBRATIONS_DIR = Join-Path $CALIBR_DATA_DIR "calibrations"
$script:CALIBR_DOWNLOADS   = Join-Path $CALIBR_DATA_DIR "downloads.json"
$script:CALIBR_DOWNLOADED_MODELS_DIR = Join-Path $CALIBR_DATA_DIR "downloaded-models"
$script:CALIBR_DEFAULT_PRESETS = Join-Path $CALIBR_ROOT     "default_bench_presets.json"
$script:CALIBR_USER_PRESETS    = Join-Path $CALIBR_DATA_DIR "user_bench_presets.json"

foreach ($d in @($CALIBR_DATA_DIR, $CALIBR_RESULTS_DIR, $CALIBR_LOGS_DIR, $CALIBR_BATS_DIR, $CALIBR_REPORTS_DIR, $CALIBR_CALIBRATIONS_DIR, $CALIBR_DOWNLOADED_MODELS_DIR)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}


# ============================================================================
# ENGINE MODULES
# ============================================================================
$script:CALIBR_ENGINE_DIR = Join-Path $CALIBR_ROOT "engine"
$script:CALIBR_ENGINE_MODULES = @(
    'trace.ps1'
    'platform.ps1'
    'config.ps1'
    'llama.ps1'
    'commands.ps1'
    'discover.ps1'
    'offload.ps1'
    'plan.ps1'
    'bench.ps1'
    'report.ps1'
    'workflow.ps1'
    'catalog.ps1'
    'doctor.ps1'
)
foreach ($m in $script:CALIBR_ENGINE_MODULES) {
    $modulePath = Join-Path $script:CALIBR_ENGINE_DIR $m
    if (-not (Test-Path -LiteralPath $modulePath)) { throw "Missing engine module: $modulePath" }
    . $modulePath
}

# ============================================================================
# DISPATCH
# ============================================================================
# When this script is dot-sourced (e.g. by tests), $MyInvocation.InvocationName
# is the literal '.'. In that case we want all the function definitions above
# to be exported into the caller's scope, but we do NOT want the dispatch
# below to fire - otherwise just dot-sourcing for tests would print the help
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
    "reset"              { Invoke-Reset }
    "get-models"         { Invoke-FetchModels }
    "doctor"             { Invoke-Doctor }
    "all"                { Invoke-All }
    default              { Invoke-Help }
}

# Some native commands we shell out to (notably nvidia-smi on certain driver
# builds) leave $LASTEXITCODE non-zero even on success, which then propagates
# to the caller as a misleading non-zero exit. If we made it here without an
# uncaught exception, the user-visible task succeeded - exit clean.
$global:LASTEXITCODE = 0
exit 0
