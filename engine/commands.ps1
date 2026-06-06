# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

function Test-IsPackagedEngineRoot {
    $rootLeaf = Split-Path $CALIBR_ROOT -Leaf
    $pkgRoot = Split-Path $CALIBR_ROOT -Parent
    return (
        $rootLeaf -eq "engine" -and
        (Test-Path -LiteralPath (Join-Path $pkgRoot "package.json")) -and
        (Test-Path -LiteralPath (Join-Path $pkgRoot "dist"))
    )
}

function Find-ModelRoots {
    # Suggest scan_paths: parent of ROOT, sibling folders that look like model storage
    # In an npm install ROOT is node_modules/calibr/engine. Recursing upward from
    # there scans node_modules and can look like init is frozen on a fresh box.
    if (Test-IsPackagedEngineRoot) { return @() }

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

function Test-ConfigNeedsInit {
    param($cfg)
    if (-not $cfg) { return $true }
    $llamaMissing = (-not $cfg.llama_server_exe -or -not (Test-Path -LiteralPath $cfg.llama_server_exe))
    $hw = $cfg.hardware
    $hardwareMissing = (-not $hw -or (-not $hw.gpu_name -and -not $hw.vram_total_mib -and -not $hw.cpu_cores_physical))
    $scanMissing = (-not $cfg.scan_paths -or @($cfg.scan_paths).Count -eq 0)
    return ($llamaMissing -or $hardwareMissing -or $scanMissing)
}

# ============================================================================
# SUBCOMMAND: init
# ============================================================================
function Invoke-Init {
    Write-Host "=== calibr init ===" -ForegroundColor Cyan

    $cfgRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $cfg = ConvertTo-Hashtable -obj $cfgRaw
    $existing = @{}
    if (Test-Path $CALIBR_LOCAL_CFG) {
        try {
            $existingRaw = Get-Content $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
            $existing = ConvertTo-Hashtable -obj $existingRaw
        } catch {
            Write-Warning "  Existing config.json is unreadable; init will rewrite it. ($($_.Exception.Message))"
            $existing = @{}
        }
    }
    $override = @{}

    Write-Host "Detecting hardware..."
    $hw = Get-DetectedHardware
    if ($hw.gpu_name) {
        $memLabel = if ($hw.memory_unified) { "$($hw.unified_memory_total_mib) MiB unified memory" } else { "$($hw.vram_total_mib) MiB VRAM" }
        $backendLabel = if ($hw.gpu_backend_hint) { ", backend $($hw.gpu_backend_hint)" } else { "" }
        Write-Host "  GPU: $($hw.gpu_name), $memLabel, compute $($hw.gpu_compute_cap)$backendLabel" -ForegroundColor Green
    } else {
        Write-Warning "  No GPU detected. Metrics may be CPU-only; set hardware.vram_total_mib manually if needed."
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
        gpu_backend_hint       = $hw.gpu_backend_hint
        memory_unified         = [bool]$hw.memory_unified
        unified_memory_total_mib = $hw.unified_memory_total_mib
        cpu_cores_physical     = $hw.cpu_cores_physical
        cpu_threads_logical    = $hw.cpu_threads_logical
    }

    if ($LlamaServer) {
        Write-Host "`nUsing -LlamaServer override: $LlamaServer" -ForegroundColor Cyan
        $override.llama_server_exe = $LlamaServer
    } elseif ($existing.llama_server_exe -and (Test-Path -LiteralPath $existing.llama_server_exe)) {
        Write-Host "`nKeeping existing llama_server_exe: $($existing.llama_server_exe)" -ForegroundColor Green
        $override.llama_server_exe = $existing.llama_server_exe
    } elseif ($AutoFetchLlama) {
        try {
            $picked = Invoke-AutoFetchLlama -Hardware $hw
            Write-Host "`nFetched: $picked" -ForegroundColor Green
            $override.llama_server_exe = $picked
        } catch {
            Write-Warning "  Auto-fetch failed: $($_.Exception.Message)"
            $override.llama_server_exe = $null
        }
    } else {
        Write-Host "`nSearching for llama-server$script:ExeExt..."
        $exes = Find-LlamaServerExe
        if ($exes.Count -eq 0) {
            $shouldFetch = $false
            if (-not $NonInteractive) {
                $answer = Read-Host "  Not found. Download official llama.cpp now? (y/N)"
                $shouldFetch = ($answer -match '^[yY]')
            }
            if ($shouldFetch) {
                try {
                    $picked = Invoke-AutoFetchLlama -Hardware $hw
                    Write-Host "  Fetched: $picked" -ForegroundColor Green
                    $override.llama_server_exe = $picked
                } catch {
                    Write-Warning "  Auto-fetch failed: $($_.Exception.Message)"
                    $override.llama_server_exe = $null
                }
            } else {
                Write-Warning "  Not found. Re-run init with -AutoFetchLlama or set llama_server_exe manually."
                $override.llama_server_exe = $null
            }
        } elseif ($exes.Count -eq 1) {
            Write-Host "  Found: $($exes[0])" -ForegroundColor Green
            $override.llama_server_exe = $exes[0]
        } else {
            Write-Host "  Multiple candidates:" -ForegroundColor Yellow
            for ($i=0; $i -lt $exes.Count; $i++) { Write-Host "    [$i] $($exes[$i])" }
            if ($NonInteractive) {
                Write-Warning "  Multiple llama-server candidates found. Re-run with -LlamaServer <path> to choose one."
                $override.llama_server_exe = $null
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
    } elseif ($existing.scan_paths -and @($existing.scan_paths).Count -gt 0) {
        Write-Host "`nKeeping existing scan_paths: $(@($existing.scan_paths) -join ', ')" -ForegroundColor Green
        $override.scan_paths = @($existing.scan_paths)
    } else {
        Write-Host "`nSearching for .gguf folders..."
        $roots = Find-ModelRoots
        if ($roots.Count -eq 0) {
            Write-Warning "  No folders with .gguf files found near this script."
            if (-not $NonInteractive) {
                $manual = Read-Host "  Enter scan path (or empty to skip)"
                if ($manual) { $override.scan_paths = @($manual) } else { $override.scan_paths = @($CALIBR_DOWNLOADED_MODELS_DIR) }
            } else {
                $override.scan_paths = @($CALIBR_DOWNLOADED_MODELS_DIR)
            }
            if (-not (Test-Path -LiteralPath $CALIBR_DOWNLOADED_MODELS_DIR)) {
                New-Item -ItemType Directory -Path $CALIBR_DOWNLOADED_MODELS_DIR -Force | Out-Null
            }
            Write-Host "  Defaulting scan_paths to $CALIBR_DOWNLOADED_MODELS_DIR" -ForegroundColor Cyan
        } else {
            Write-Host "  Found $($roots.Count) candidate root(s):" -ForegroundColor Green
            $roots | ForEach-Object { Write-Host "    $_" }
            $override.scan_paths = $roots
        }
    }

    # Write config.json. If a partial local config already exists (for example
    # created by the CLI's "configure llama path" picker), init augments it
    # instead of refusing to run. This is the fresh-machine path.
    $out = [ordered]@{}
    if ((Test-Path $CALIBR_LOCAL_CFG) -and (-not $Force)) {
        foreach ($k in $existing.Keys) { $out[$k] = $existing[$k] }
    }
    if ($override.ContainsKey('llama_server_exe')) { $out.llama_server_exe = $override.llama_server_exe }
    if ($override.ContainsKey('scan_paths'))       { $out.scan_paths = @($override.scan_paths) }
    $out.hardware = @{
        auto_detect            = $false
        vram_total_mib         = $override.hardware.vram_total_mib
        vram_safety_budget_mib = $override.hardware.vram_safety_budget_mib
        gpu_name               = $override.hardware.gpu_name
        gpu_compute_cap        = $override.hardware.gpu_compute_cap
        gpu_backend_hint       = $override.hardware.gpu_backend_hint
        memory_unified         = [bool]$override.hardware.memory_unified
        unified_memory_total_mib = $override.hardware.unified_memory_total_mib
        cpu_cores_physical     = $override.hardware.cpu_cores_physical
        cpu_threads_logical    = $override.hardware.cpu_threads_logical
    }

    $out | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
    Write-Host "`nWrote $CALIBR_LOCAL_CFG" -ForegroundColor Green
    Write-Host "Next: calibr discover" -ForegroundColor Cyan
}


# ============================================================================
# SUBCOMMAND: status
# ============================================================================
function Get-ResetTargets {
    # Pure: given the toggle hashtable + paths, returns an ordered list of
    # @{kind; path; description} entries describing what would be wiped.
    # Caller decides whether to actually act. Keeps Invoke-Reset itself a
    # thin wrapper that's easy to dry-run and easy to test.
    #
    # The `-All` toggle is expanded here, NOT in Invoke-Reset, so a single
    # source of truth governs what 'reset everything' means.
    param(
        [hashtable]$Toggles,         # { Results=$true; Catalog=$false; ... }
        [hashtable]$Paths,           # { ResultsDir=...; CatalogFile=...; ... }
        [string[]]$ManagedFiles      # absolute paths of files currently in download manifest
    )
    $t = $Toggles
    if ($t.All) {
        # -All implies every bucket. We DO include DownloadedModels and
        # LocalConfig in 'all' on purpose - those are the two most
        # destructive ones and we want -All to mean 'truly factory reset'.
        $t = @{
            Results = $true; Catalog = $true; Plan = $true; Report = $true
            Logs = $true; Bats = $true; Downloads = $true
            DownloadedModels = $true; LocalConfig = $true
        }
    }
    $out = @()
    if ($t.Results -and (Test-Path $Paths.ResultsDir)) {
        $count = (Get-ChildItem $Paths.ResultsDir -Filter '*.json' -ErrorAction SilentlyContinue).Count
        $out += @{ kind = 'results'; path = $Paths.ResultsDir; description = "$count bench result JSON file(s)" }
    }
    if ($t.Catalog -and (Test-Path $Paths.CatalogFile)) {
        $out += @{ kind = 'catalog'; path = $Paths.CatalogFile; description = "catalog.json (model index from discover)" }
    }
    if ($t.Plan -and (Test-Path $Paths.PlanFile)) {
        $out += @{ kind = 'plan'; path = $Paths.PlanFile; description = "plan.json (expanded bench configs)" }
    }
    if ($t.Report -and (Test-Path $Paths.ReportFile)) {
        $out += @{ kind = 'report'; path = $Paths.ReportFile; description = "report.html (regenerable from results)" }
    }
    if ($t.Report -and $Paths.ReportsArchiveDir -and (Test-Path $Paths.ReportsArchiveDir)) {
        $archived = (Get-ChildItem $Paths.ReportsArchiveDir -Filter '*.html' -ErrorAction SilentlyContinue).Count
        if ($archived -gt 0) {
            $out += @{ kind = 'reports_archive'; path = $Paths.ReportsArchiveDir; description = "$archived archived report(s) under data/reports/" }
        }
    }
    if ($t.Logs -and (Test-Path $Paths.LogsDir)) {
        $count = (Get-ChildItem $Paths.LogsDir -Filter '*.log' -ErrorAction SilentlyContinue).Count
        $out += @{ kind = 'logs'; path = $Paths.LogsDir; description = "$count llama-server log file(s)" }
    }
    if ($t.Bats -and (Test-Path $Paths.BatsDir)) {
        $count = (Get-ChildItem $Paths.BatsDir -Filter $(if ($script:IsWin) { '*.bat' } else { '*.sh' }) -ErrorAction SilentlyContinue).Count
        $out += @{ kind = 'bats'; path = $Paths.BatsDir; description = "$count winner launch script(s)" }
    }
    if ($t.Downloads -and (Test-Path $Paths.DownloadsFile)) {
        $out += @{ kind = 'downloads'; path = $Paths.DownloadsFile; description = "downloads.json manifest (rotation tracking; the .gguf files themselves are a SEPARATE bucket)" }
    }
    if ($t.DownloadedModels) {
        foreach ($p in $ManagedFiles) {
            if ($p -and (Test-Path -LiteralPath $p)) {
                $sz = [math]::Round((Get-Item -LiteralPath $p).Length / 1GB, 2)
                $out += @{ kind = 'downloaded_model'; path = $p; description = "$sz GB .gguf (calibr-downloaded)" }
            }
        }
    }
    if ($t.LocalConfig -and (Test-Path $Paths.LocalConfigFile)) {
        $out += @{ kind = 'local_config'; path = $Paths.LocalConfigFile; description = "config.json (your local overrides; default config.default.json stays)" }
    }
    return ,@($out)
}

function Invoke-Reset {
    # Wipes the runtime state pieces selected by the param-block toggles.
    # Confirmation in interactive mode; -NonInteractive (the CLI sets it
    # automatically) skips the prompt and trusts the caller's earlier
    # confirmation. User-owned .gguf files in scan_paths are NEVER touched
    # - only files recorded in data/downloads.json can be deleted, and
    # only when -DownloadedModels (or -All) is on.
    $toggles = @{
        Results          = [bool]$Results
        Catalog          = [bool]$Catalog
        Plan             = [bool]$Plan
        Report           = [bool]$Report
        Logs             = [bool]$Logs
        Bats             = [bool]$Bats
        Downloads        = [bool]$Downloads
        DownloadedModels = [bool]$DownloadedModels
        LocalConfig      = [bool]$LocalConfig
        All              = [bool]$All
    }
    $paths = @{
        ResultsDir         = $CALIBR_RESULTS_DIR
        CatalogFile        = $CALIBR_CATALOG
        PlanFile           = $CALIBR_PLAN
        ReportFile         = $CALIBR_REPORT
        ReportsArchiveDir  = $CALIBR_REPORTS_DIR
        LogsDir            = $CALIBR_LOGS_DIR
        BatsDir            = $CALIBR_BATS_DIR
        DownloadsFile      = $CALIBR_DOWNLOADS
        LocalConfigFile    = $CALIBR_LOCAL_CFG
    }
    $managed = @(Get-DownloadManifest | Where-Object { $_ -and $_.model_path } | ForEach-Object {
        # Include the mmproj too if the entry tracked one.
        $_.model_path
        if ($_.mmproj_path) { $_.mmproj_path }
    })

    $targets = Get-ResetTargets -Toggles $toggles -Paths $paths -ManagedFiles $managed

    Write-Host "=== reset ===" -ForegroundColor Cyan
    if ($targets.Count -eq 0) {
        Write-Host "Nothing selected. Pass one or more of: -Results -Catalog -Plan -Report -Logs -Bats -Downloads -DownloadedModels -LocalConfig -All" -ForegroundColor Yellow
        return
    }
    foreach ($t in $targets) {
        Write-Host ("  [{0}] {1}  ({2})" -f $t.kind, $t.path, $t.description) -ForegroundColor DarkGray
    }
    if (-not $NonInteractive) {
        $ok = Read-Host "`nProceed? This cannot be undone. (y/N)"
        if ($ok -notmatch '^[yY]') { Write-Host "Cancelled." -ForegroundColor Yellow; return }
    }

    $okCount = 0; $failCount = 0
    foreach ($t in $targets) {
        try {
            if (Test-Path -LiteralPath $t.path) {
                $isDir = (Get-Item -LiteralPath $t.path).PSIsContainer
                if ($t.kind -in @('results','logs','bats','reports_archive') -and $isDir) {
                    # Wipe contents but keep the directory; the engine
                    # recreates it on demand and removing the dir itself
                    # buys nothing.
                    $glob = switch ($t.kind) {
                        'results'          { '*.json' }
                        'logs'             { '*.log' }
                        'bats'             { if ($script:IsWin) { '*.bat' } else { '*.sh' } }
                        'reports_archive'  { '*.html' }
                    }
                    Get-ChildItem $t.path -Filter $glob -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction Stop
                } else {
                    Remove-Item -LiteralPath $t.path -Force -ErrorAction Stop
                }
            }
            Write-Host ("  removed: {0}" -f $t.path) -ForegroundColor DarkCyan
            $okCount++
        } catch {
            Write-Host ("  FAILED: {0} ({1})" -f $t.path, $_.Exception.Message) -ForegroundColor Red
            $failCount++
        }
    }
    Write-Host ""
    Write-Host ("reset done: {0} removed, {1} failed" -f $okCount, $failCount) -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Yellow' })
}

function Invoke-Status {
    $cfg = Get-Config
    # Keep the reported counts honest with disk: prune entries for models that
    # were rotated/deleted so 'status' (and the CLI card that mirrors it) never
    # advertises a model that can't actually run.
    Remove-PhantomEntries | Out-Null
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
    $installScope = if ($script:IsWin) { 'yes (User scope)' } else { "yes ($script:CALIBR_NIX_LAUNCHER)" }
    Write-Host "  global PATH: $(if ($installed) { $installScope } else { 'no  (run: calibr install)' })"
}

# ============================================================================
# SUBCOMMAND: install / uninstall (manage User PATH so `calibr` works globally)
# ============================================================================
$script:CALIBR_NIX_LAUNCHER = Join-Path $HOME '.local/bin/calibr'

function Test-LlmLabInstalled {
    if (-not $script:IsWin) { return (Test-Path $script:CALIBR_NIX_LAUNCHER) }
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if (-not $userPath) { return $false }
    $entries = $userPath -split ';' | Where-Object { $_ }
    return ($entries -contains $CALIBR_ROOT)
}

function Invoke-Install {
    Write-Host "=== install ===" -ForegroundColor Cyan
    if (-not $script:IsWin) {
        # No registry PATH on POSIX: drop a small wrapper into ~/.local/bin
        # that runs the engine through pwsh. ~/.local/bin is the conventional
        # user-level bin dir and is on PATH in most modern distros.
        $binDir   = Split-Path $script:CALIBR_NIX_LAUNCHER -Parent
        if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
        $ps1      = Join-Path $CALIBR_ROOT 'calibr.ps1'
        $wrapper  = @(
            '#!/usr/bin/env bash'
            "exec pwsh -NoProfile -File `"$ps1`" `"`$@`""
        ) -join "`n"
        [System.IO.File]::WriteAllText($script:CALIBR_NIX_LAUNCHER, $wrapper + "`n", (New-Object System.Text.UTF8Encoding($false)))
        try { & chmod +x $script:CALIBR_NIX_LAUNCHER 2>$null } catch { }
        Write-Host "Wrote launcher: $script:CALIBR_NIX_LAUNCHER" -ForegroundColor Green
        if (($env:PATH -split ':') -notcontains $binDir) {
            Write-Host "NOTE: '$binDir' is not on your PATH. Add this to your shell profile:" -ForegroundColor Yellow
            Write-Host "  export PATH=`"`$HOME/.local/bin:`$PATH`""
        }
        Write-Host ""
        Write-Host "You can now run 'calibr <command>' from any directory." -ForegroundColor Cyan
        Write-Host "Try:  calibr status"
        return
    }
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
    if (-not $script:IsWin) {
        if (Test-Path $script:CALIBR_NIX_LAUNCHER) {
            Remove-Item -LiteralPath $script:CALIBR_NIX_LAUNCHER -Force
            Write-Host "Removed launcher: $script:CALIBR_NIX_LAUNCHER" -ForegroundColor Green
        } else {
            Write-Host "Not installed: '$script:CALIBR_NIX_LAUNCHER' does not exist." -ForegroundColor DarkGray
        }
        return
    }
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
# SUBCOMMAND: all
# ============================================================================
function Invoke-All {
        # Auto-init when llama_server_exe is missing/invalid. Saves the
        # user from having to know they were supposed to run 'init'
        # first; on a fresh box the engine auto-detects llama-server in
        # PATH or sibling folders and writes config.json. Only if the
        # auto-init can't find anything do we throw - and at that point
        # the message tells them WHERE we looked.
        $cfgUp = Get-Config
        if (Test-ConfigNeedsInit -cfg $cfgUp) {
            Write-Host "[all] setup incomplete - running 'init' first..." -ForegroundColor Cyan
            $savedNI = $script:NonInteractive
            $savedForce = $script:Force
            $script:NonInteractive = $true   # don't prompt mid-pipeline
            $script:Force          = $false  # preserve partial config values from the CLI picker
            try {
                Invoke-Init
            } catch {
                Write-Host ("[all] init failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
            } finally {
                $script:NonInteractive = $savedNI
                $script:Force          = $savedForce
            }
            $cfgUp = Get-Config
            if (-not $cfgUp.llama_server_exe -or -not (Test-Path $cfgUp.llama_server_exe)) {
                throw "llama-server$script:ExeExt could not be configured. Run 'calibr init -AutoFetchLlama' to download llama.cpp automatically, or run 'calibr init -LlamaServer <path>' if you already have a build."
            }
            Write-Host ("[all] init done. llama_server_exe = {0}" -f $cfgUp.llama_server_exe) -ForegroundColor Green
        }
        if ($FetchCatalog) {
            # Interleaved rotation: instead of fetching the entire curated set
            # up-front (~88 GB peak) and benching afterwards, we walk one
            # sample at a time - download -> discover -> plan -> bench just this
            # model -> rotation deletes it - so the working set on disk stays
            # bounded to one model. This is what makes -KeepDownloads=off
            # actually deliver the 'peak ~ largest single file' promise the
            # CLI's pre-flight gate shows.
            $samples = Get-ModelCatalog
            # Preset narrows the catalog to a hardware-tier-curated subset
            # (low / middle / high / user-saved). Applied BEFORE the
            # other filters so -CatalogId / -Model can further narrow
            # inside the preset.
            $presetMaxCtx = 0
            if ($Preset) {
                $presetObj = Get-Preset -Name $Preset
                if ($null -eq $presetObj) {
                    $known = ((Get-PresetCatalog).Keys | Sort-Object) -join ', '
                    throw "Preset '$Preset' not found. Known: $known"
                }
                $samples = Select-CatalogByPreset -catalog $samples -preset $presetObj
                if ($null -ne $presetObj.max_ctx) {
                    $presetMaxCtx = [int]$presetObj.max_ctx
                    $script:_presetMaxCtx = $presetMaxCtx
                }
                Write-Host ("[all] preset '{0}': {1} entries, max_ctx={2}" -f $Preset, $samples.Count, $(if ($presetMaxCtx -gt 0) { $presetMaxCtx } else { '(no cap)' })) -ForegroundColor Cyan
            }
            if ($CatalogId) {
                # Accept a comma-separated list (e.g. 'qwen3.5-9b-q4km,gemma-4-e2b')
                # so the CLI's CustomBenchView can pass a multi-pick selection,
                # while a single id with wildcards (e.g. 'qwen*') keeps the
                # old -like semantics.
                $idPatterns = @(($CatalogId -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                $samples = $samples | Where-Object {
                    foreach ($pat in $idPatterns) { if ($_.id -like $pat) { return $true } }
                    return $false
                }
            }
            if ($Model)    { $samples = $samples | Where-Object { $_.model -match $Model } }
            $samples = @($samples)
            if ($samples.Count -eq 0) {
                Write-Host "No samples match the current -CatalogId / -Model filters. Nothing to do." -ForegroundColor Yellow
                return
            }

            # Point scan_paths at the download destination if the user hasn't
            # configured it; otherwise discover would later throw 'scan_paths
            # is empty'.
            $cfgInit = Get-Config
            $scanEmpty = (-not $cfgInit.scan_paths -or $cfgInit.scan_paths.Count -eq 0)
            $cliEmpty  = (-not $script:ScanPath  -or $script:ScanPath.Count  -eq 0)
            if ($scanEmpty -and $cliEmpty) {
                $defaultDl = if ($Destination) { $Destination } else { $CALIBR_DOWNLOADED_MODELS_DIR }
                $script:ScanPath = @($defaultDl)
                Write-Host "[all] No scan_paths configured. Will scan $defaultDl." -ForegroundColor Cyan
            }

            Write-Host ""
            Write-Host ("=== all -FetchCatalog : {0} sample(s), rotated ===" -f $samples.Count) -ForegroundColor Cyan

            # Phase 0: bench whatever is already on disk so existing models
            # don't get orphaned by the per-sample loop (each iteration's
            # bench is narrowed to the current sample's model). Skipped if
            # the user explicitly scoped with -CatalogId or -Model - then
            # they want a narrow run, not a sweep over everything.
            if (-not $CatalogId -and -not $Model) {
                Write-Host ""
                Write-Host "--- pre-existing models ---" -ForegroundColor DarkCyan
                Invoke-Discover
                Invoke-Plan
                Invoke-Bench
            }

            # Phase 1+: per-sample download + bench + rotate.
            $savedCatalogId = $script:CatalogId
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

                $script:CatalogId = $s.id
                $script:Model    = ""   # CatalogId narrows enough on its own
                Invoke-FetchModels

                # Re-discover so the freshly-downloaded file enters the catalog;
                # re-plan because the catalog grew.
                $script:CatalogId = $savedCatalogId
                Invoke-Discover
                Invoke-Plan

                # Bench narrows to this sample's model - Invoke-RotationCheck
                # then has a chance to delete the .gguf the moment its last
                # config finishes successfully.
                $script:Model = $s.model
                Invoke-Bench
            }
            $script:CatalogId = $savedCatalogId
            $script:Model    = $savedModel

            Write-Host ""
            Write-Host "--- final report ---" -ForegroundColor DarkCyan
            Invoke-Report
        } else {
            Invoke-Discover; Invoke-Plan; Invoke-Bench; Invoke-Report
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
        "all"               = "discover + plan + bench + report (optionally + fetch from model catalog)."
        "status"            = "Show config + counts (catalog/plan/results) + global-install state."
        "config"            = "Get / set / list / unset config values from CLI."
        "get-models" = "List or download entries from the curated model catalog (HuggingFace)."
        "doctor"            = "Sanity-check the system (CPU/GPU/OS + deps); show what's missing + how to fix it."
        "install"           = "Add this directory to user PATH so 'calibr' works globally."
        "uninstall"         = "Remove this directory from user PATH."
        "reset"             = "Wipe runtime state (results, catalog, plan, report, logs, bats, downloads, calibr-downloaded models, local config)."
        "help"              = "This screen, or 'help <command>' for details."
    }

    $details = @{
        "init" = @{
            Usage    = "calibr init [-AutoFetchLlama [-LlamaCppBuild bNNNN]] [-LlamaServer <path>] [-ScanPath <paths>] [-Force] [-NonInteractive]"
            Flags    = @(
                "-AutoFetchLlama       Download an official llama.cpp build if llama-server is missing"
                "-LlamaCppBuild bNNNN   With -AutoFetchLlama, pin a specific llama.cpp release"
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
            Usage    = "calibr all [-AutoFetchLlama [-LlamaCppBuild bNNNN]] [-FetchCatalog [-CatalogId <id>] [-Model <regex>]] [-Force] [-PreferSpeed] [-KeepDownloads]"
            Flags    = @(
                "-AutoFetchLlama       Run init with automatic llama.cpp download when setup is incomplete"
                "-LlamaCppBuild bNNNN   With -AutoFetchLlama, pin a specific llama.cpp release"
                "-FetchCatalog         Interleaved mode: walk catalog entries one-by-one,"
                "                         download -> discover -> plan -> bench -> rotate per"
                "                         entry so peak disk stays bounded to one model."
                "                         Pre-existing models in scan_paths are benched first"
                "                         (phase 0)."
                "-CatalogId <id>           (with -FetchCatalog) only fetch the matching entry"
                "-Model <regex>           Filter download AND bench by model name"
                "-Force                   Re-run all benchmarks (skip cache)"
                "-PreferSpeed             Pick fastest config per model, ignore WDDM safety"
                "-KeepDownloads           Opt out of post-bench rotation. By default with"
                "                         -FetchCatalog, calibr-downloaded files are deleted"
                "                         after a clean bench to bound peak disk to one model."
            )
            Examples = @(
                "calibr all"
                "calibr all -FetchCatalog"
                "calibr all -FetchCatalog -CatalogId qwen3.5-9b-q4km"
                "calibr all -FetchCatalog -KeepDownloads"
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
        "get-models" = @{
            Usage    = "calibr get-models [-DownloadAll | -CatalogId <id> | -Model <regex>] [-Destination <path>] [-DryRun]"
            Flags    = @(
                "(no flag)                  Print catalog as a dry listing"
                "-DownloadAll               Download every entry (asks confirmation, ~100 GB)"
                "-CatalogId <id>             Download only the matching catalog entry id"
                "-Model <regex>             Filter catalog entries by model name"
                "-Destination <path>        Override target root (default: scan_paths[0])"
                "-DryRun                    Show what would be downloaded without doing it"
            )
            Examples = @(
                "calibr get-models"
                "calibr get-models -CatalogId qwen3.5-9b-q4km"
                "calibr get-models -DownloadAll"
            )
        }
        "doctor" = @{
            Usage    = "calibr doctor [-Extended] [-Json] [-Export [-ExportPath <file>]]"
            Flags    = @(
                "(no flags)                 Print a human checklist: system info + every dep"
                "                           with status (ok/warn/fail/missing/skipped) and the"
                "                           exact fix for anything that isn't ok."
                "-Extended                  Keep full (uncapped) command logs in the bundle."
                "-Json                      Emit the diagnostic contract as JSON to stdout"
                "                           (what the CLI's doctor view consumes)."
                "-Export                    Write the JSON bundle to data/doctor-report.json"
                "                           (home dir + hostname redacted). Attach it to an"
                "                           'unable to start' issue."
                "-ExportPath <file>         Override the export destination."
            )
            Examples = @(
                "calibr doctor"
                "calibr doctor -Extended"
                "calibr doctor -Export -Extended"
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
        "reset" = @{
            Usage    = "calibr reset [-Results] [-Catalog] [-Plan] [-Report] [-Logs] [-Bats] [-Downloads] [-DownloadedModels] [-LocalConfig] [-All]"
            Flags    = @(
                "-Results           Wipe data/results/*.json (clear the bench cache)"
                "-Catalog           Wipe data/catalog.json (forces re-discover)"
                "-Plan              Wipe data/plan.json (forces re-plan)"
                "-Report            Wipe data/report.html"
                "-Logs              Wipe data/logs/*.log (llama-server stderr per config)"
                "-Bats              Wipe data/bats/*.bat (per-winner launchers)"
                "-Downloads         Wipe data/downloads.json (rotation manifest only)"
                "-DownloadedModels  Delete the .gguf+mmproj files calibr fetched"
                "                   (the ones tracked in data/downloads.json)."
                "                   User-owned .gguf files in scan_paths are NEVER touched."
                "-LocalConfig       Wipe config.json (your local overrides). The default"
                "                   config.default.json stays - calibr remains runnable."
                "-All               Convenience flag for every bucket above (factory reset)."
                ""
                "Interactive mode prompts y/N before deleting; -NonInteractive (which"
                "the calibr CLI sets automatically) trusts the caller and proceeds."
            )
            Examples = @(
                "calibr reset -Results -Report                 # ri-bench tutto, riusa download e catalog"
                "calibr reset -Catalog -Plan                   # forza ri-discover + ri-plan"
                "calibr reset -DownloadedModels                # libera disco da modelli scaricati"
                "calibr reset -All -NonInteractive             # factory reset, niente prompt"
            )
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

