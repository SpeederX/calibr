# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: get-models
# ============================================================================
function Get-ModelCatalog {
    $samplesFile = Join-Path $CALIBR_ROOT "models_catalog.json"
    if (-not (Test-Path $samplesFile)) { throw "models_catalog.json missing at $samplesFile" }
    $raw = Get-Content $samplesFile -Raw | ConvertFrom-Json
    return $raw.models
}

function Get-PresetCatalog {
    # Returns a hashtable {presetName -> presetObject} merging defaults
    # (default_bench_presets.json at repo root, ships in the tarball) and
    # user-saved presets (data/user_bench_presets.json). Same-name user
    # presets fully REPLACE the default - pick a different name if you
    # want to keep both.
    $merged = @{}
    foreach ($path in @($CALIBR_DEFAULT_PRESETS, $CALIBR_USER_PRESETS)) {
        if (-not (Test-Path $path)) { continue }
        try {
            $raw = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($raw -and $raw.presets) {
                foreach ($prop in $raw.presets.PSObject.Properties) {
                    $merged[$prop.Name] = $prop.Value
                }
            }
        } catch {
            Write-Warning ("preset file unreadable, skipped: {0} ({1})" -f $path, $_.Exception.Message)
        }
    }
    return $merged
}

function Get-Preset {
    param([Parameter(Mandatory)][string]$Name)
    $all = Get-PresetCatalog
    if ($all.ContainsKey($Name)) { return $all[$Name] }
    return $null
}

function Select-CatalogByPreset {
    # Pure filter: given the full catalog list and a preset object (with
    # .models which is either '*' or an array of catalog ids), returns the
    # subset of the catalog that the preset selects. Used by the `all`
    # dispatcher and tested independently.
    param($catalog, $preset)
    return Select-ModelCatalog -Catalog $catalog -Preset $preset
}

function Test-CatalogIdMatch {
    param(
        [string]$Id,
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Id -like $pattern) { return $true }
    }
    return $false
}

function Select-ModelCatalog {
    param(
        $Catalog,
        $Preset = $null,
        [string]$CatalogId = "",
        [string]$ModelRegex = ""
    )

    $selected = @($Catalog)
    if ($null -ne $Preset -and -not ($Preset.models -is [string] -and $Preset.models -eq '*')) {
        $presetIds = @($Preset.models)
        $selected = @($selected | Where-Object { $presetIds -contains $_.id })
    }
    if ($CatalogId) {
        $patterns = @(($CatalogId -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $selected = @($selected | Where-Object { Test-CatalogIdMatch -Id $_.id -Patterns $patterns })
    }
    if ($ModelRegex) {
        $selected = @($selected | Where-Object { $_.model -match $ModelRegex })
    }
    return $selected
}

# Download manifest: records which .gguf files calibr itself fetched. Used by
# bench's post-config rotation step to decide whether a file is safe to delete
# (entries in the manifest = downloaded by calibr; absence = user-owned, never
# touched). Manifest entries are kept after the file is rotated off disk so a
# re-download via `get-models -CatalogId` is one command.
function Get-DownloadManifest {
    # Emits each manifest entry as its own pipeline value (or no values if
    # the file is missing/empty/corrupt). Enumerating here, instead of
    # returning the parsed array as a single pipeline value, is what lets
    # callers do `@(Get-DownloadManifest)` and get a flat array - otherwise
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
    # so re-running `get-models` for the same sample updates the timestamp
    # in place.
    param(
        [Parameter(Mandatory)][string]$CatalogId,
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
        catalog_id    = $CatalogId
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

function Remove-DownloadManifestEntry {
    param([Parameter(Mandatory)][string]$ModelPath)
    if (-not (Test-Path $CALIBR_DOWNLOADS)) { return }
    $remaining = @(Get-DownloadManifest | Where-Object {
        $_ -and $_.model_path -and $_.model_path -ine $ModelPath
    })
    if ($remaining.Count -gt 0) {
        ConvertTo-Json -InputObject $remaining -Depth 5 | Out-File -Encoding utf8 $CALIBR_DOWNLOADS
    } else {
        Remove-Item -LiteralPath $CALIBR_DOWNLOADS -Force -ErrorAction SilentlyContinue
    }
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

function Get-DownloadDestination {
    param($sample, $cfg)
    # Priority: -Destination flag > scan_paths[0] > data/downloaded-models.
    # In an npm install $CALIBR_ROOT lives inside node_modules, so runtime
    # downloads must fall back to CALIBR_DATA_DIR, not the package directory.
    $root = if ($Destination) { $Destination }
            elseif ($cfg.scan_paths -and $cfg.scan_paths.Count -gt 0) { $cfg.scan_paths[0] }
            else { $CALIBR_DOWNLOADED_MODELS_DIR }
    return (Join-Path $root $sample.target_dir)
}

function Resolve-TsModelDownloadScript {
    if ($env:CALIBR_TS_MODEL_DOWNLOAD -eq '0') { return "" }
    if ($env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT -and (Test-Path -LiteralPath $env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT)) {
        return $env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT
    }
    $candidates = @(
        (Join-Path $script:CALIBR_ROOT "cli\dist\engine\catalog\modelDownloadCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\engine\catalog\modelDownloadCli.js")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ""
}

function Invoke-TsModelDownload {
    # Spawns the Node downloader (resume + integrity + atomic rename). The
    # download/skip decision is made by file validity, NOT $Force - re-running
    # benchmarks must never re-download an already-valid model. Returns the
    # parsed result hashtable, or $null when Node could not run (caller then
    # falls back to the PowerShell path).
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string]$DestPath,
        [Parameter(Mandatory)][string]$Script
    )
    $payload = @{
        repo        = $Repo
        file        = $File
        destPath    = $DestPath
        calibrOwned = [bool](Test-DownloadedByCalibr -Path $DestPath)
    }
    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("model-download-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        [System.IO.File]::WriteAllText(
            $payloadPath,
            ($payload | ConvertTo-Json -Depth 5),
            (New-Object System.Text.UTF8Encoding($false))
        )
        $lastJson = $null
        & $node $Script --json-file $payloadPath 2>&1 | ForEach-Object {
            $line = $_.ToString()
            $trimmed = $line.TrimStart()
            if ($trimmed.StartsWith('[')) {
                Write-Host $line          # pass [phase]/[dlprog]/[dldone] through to the CLI
            } elseif ($trimmed.StartsWith('{')) {
                $lastJson = $line
            }
        }
        if (-not $lastJson) { return $null }
        $result = ConvertTo-Hashtable -obj ($lastJson | ConvertFrom-Json)
        switch ([string]$result.action) {
            'skip'                { Write-Host ("  [skip] already present: {0} ({1})" -f $DestPath, (Format-HumanSize ([long]$result.bytes))) -ForegroundColor DarkGray }
            'user-owned-mismatch' { Write-Host ("  [keep] {0}" -f $result.reason) -ForegroundColor Yellow }
            default {
                if ($result.ok) { Write-Host ("  [done] {0} ({1})" -f $DestPath, (Format-HumanSize ([long]$result.bytes))) -ForegroundColor Green }
                else            { Write-Host ("  [FAIL] {0}" -f $result.reason) -ForegroundColor Red }
            }
        }
        return $result
    } catch {
        Write-Host ("  [download] Node downloader error: {0}" -f $_.Exception.Message) -ForegroundColor Red
        return $null
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-DownloadRoot {
    param($cfg)
    if ($Destination) { return $Destination }
    if ($cfg.scan_paths -and $cfg.scan_paths.Count -gt 0) { return $cfg.scan_paths[0] }
    return $CALIBR_DOWNLOADED_MODELS_DIR
}

function Resolve-TsModelIntakeScript {
    if ($env:CALIBR_TS_MODEL_INTAKE -eq '0') { return "" }
    if ($env:CALIBR_TS_MODEL_INTAKE_SCRIPT -and (Test-Path -LiteralPath $env:CALIBR_TS_MODEL_INTAKE_SCRIPT)) {
        return $env:CALIBR_TS_MODEL_INTAKE_SCRIPT
    }
    $candidates = @(
        (Join-Path $script:CALIBR_ROOT "cli\dist\engine\catalog\modelIntakeCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\engine\catalog\modelIntakeCli.js")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ""
}

function Invoke-TsCatalogPlan {
    # Upfront pre-pass over the scope: returns @{ items; total; toDownload;
    # transferBytes } or $null when the Node intake could not run.
    param([object[]]$Entries, [string]$DestRoot, [string]$Script)
    $payload = @{
        entries = @($Entries | ForEach-Object {
            @{ id = $_.id; hf_repo = $_.hf_repo; hf_file = $_.hf_file; target_dir = $_.target_dir; size_bytes = $_.size_bytes }
        })
        destRoot = $DestRoot
    }
    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("catalog-plan-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        [System.IO.File]::WriteAllText($payloadPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
        $out = & $node $Script --mode plan --json-file $payloadPath 2>&1
        $json = @($out | Where-Object { $_ -and $_.ToString().TrimStart().StartsWith('{') } | Select-Object -Last 1)
        if ($json.Count -eq 0) { return $null }
        return ConvertTo-Hashtable -obj ($json[0] | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-TsCatalogIntake {
    # Per-model intake (download-if-missing + read header + signature) for one
    # catalog entry. Passes through [phase]/[dlprog]/[dldone]/[warn] markers and
    # returns @{ ok; metadata; downloaded; errorKind; error } or $null when the
    # Node intake could not run (caller falls back to the PowerShell path).
    param([object]$Entry, [string]$DestRoot, [string]$Script)
    $modelPath = Join-Path (Join-Path $DestRoot $Entry.target_dir) $Entry.hf_file
    $payload = @{
        entry = @{
            id = $Entry.id
            hf_repo = $Entry.hf_repo
            hf_file = $Entry.hf_file
            target_dir = $Entry.target_dir
            size_bytes = $Entry.size_bytes
            sha256 = $Entry.sha256
            reasoning_mode = $Entry.reasoning_mode
            template_note = $Entry.template_note
        }
        destRoot = $DestRoot
        calibrOwned = [bool](Test-DownloadedByCalibr -Path $modelPath)
        telemetry = $false
    }
    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("model-intake-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        [System.IO.File]::WriteAllText($payloadPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
        $lastJson = $null
        & $node $Script --mode intake --json-file $payloadPath 2>&1 | ForEach-Object {
            $line = $_.ToString(); $trimmed = $line.TrimStart()
            if ($trimmed.StartsWith('[')) { Write-Host $line }
            elseif ($trimmed.StartsWith('{')) { $lastJson = $line }
        }
        if (-not $lastJson) { return $null }
        return ConvertTo-Hashtable -obj ($lastJson | ConvertFrom-Json)
    } catch {
        Write-Host ("  [intake] Node error: {0}" -f $_.Exception.Message) -ForegroundColor Red
        return $null
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-HFDownload {
    # Download one file from Hugging Face via the Node downloader (resume +
    # integrity + atomic rename; it creates the destination dir and emits the
    # [dlprog]/[dldone] markers). Returns $true on success/skip, $false on a
    # download failure; throws if the Node build is missing. $ExpectedBytes is
    # kept for signature compatibility - the Node side gets the authoritative
    # size from Hugging Face.
    param(
        [string]$Repo,
        [string]$File,
        [string]$DestPath,
        [long]$ExpectedBytes = 0
    )

    # Node-only download: real HTTP Range resume, size+sha integrity, atomic
    # .part -> final rename, and a skip decision by file validity (not $Force).
    # No PowerShell fallback by design - if the Node build is missing or the
    # download fails, surface it (throw) instead of masking the problem.
    $tsScript = Resolve-TsModelDownloadScript
    if (-not $tsScript) {
        throw "Node downloader build not found. Run 'npm run build' in cli/ (expected dist/engine/catalog/modelDownloadCli.js)."
    }
    $tsResult = Invoke-TsModelDownload -Repo $Repo -File $File -DestPath $DestPath -Script $tsScript
    if ($null -eq $tsResult) { throw "Node downloader produced no result for $Repo/$File" }
    return [bool]$tsResult.ok
}

function Invoke-FetchModels {
    $cfg = Get-Config
    $samples = Get-ModelCatalog

    $filtered = @(Select-ModelCatalog -Catalog $samples -CatalogId $CatalogId -ModelRegex $Model)

    Write-Host "=== get-models ===" -ForegroundColor Cyan
    Write-Host ("Model catalog: {0} entries" -f $samples.Count)
    if ($Model -or $CatalogId) {
        Write-Host ("Filtered: {0} matching" -f @($filtered).Count)
    }
    Write-Host ""

    # Always print the table first
    $fmt = "  {0,-2} {1,-24} {2,-30} {3,-14} {4,10}  {5}"
    Write-Host ($fmt -f "", "ID", "Model", "Variant", "Size", "HF repo") -ForegroundColor White
    Write-Host ($fmt -f "", ("-"*24), ("-"*30), ("-"*14), ("-"*10), ("-"*40)) -ForegroundColor DarkGray
    foreach ($s in $filtered) {
        $dest = Get-DownloadDestination -sample $s -cfg $cfg
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
    } elseif ($CatalogId -or $Model) {
        $toDownload = @($filtered)
    } else {
        Write-Host "`nNo -CatalogId, -Model or -DownloadAll passed: nothing to download. This was a dry listing." -ForegroundColor Yellow
        Write-Host "Examples:" -ForegroundColor Yellow
        Write-Host "  calibr get-models -CatalogId qwen3.5-9b-q4km"
        Write-Host "  calibr get-models -Model 'Qwen3.5'"
        Write-Host "  calibr get-models -DownloadAll   # requires confirmation"
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
                else { $CALIBR_DOWNLOADED_MODELS_DIR }
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
        $dest = Get-DownloadDestination -sample $s -cfg $cfg
        $modelPath = Join-Path $dest $s.hf_file
        # Remember whether the file was already there before the call. If
        # Invoke-HFDownload returns OK because the file existed, we treat it
        # as user-owned and skip the manifest tag - rotation must never
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
        # files the user pre-downloaded - even into the same curated path
        # models_catalog.json points to - are never tagged calibr-owned and never
        # rotated.
        if ($ok -and -not $modelExistedBefore) {
            $modelAbs = (Get-Item -LiteralPath $modelPath).FullName
            $mmAbs = if ($mmPath -and (Test-Path $mmPath)) { (Get-Item -LiteralPath $mmPath).FullName } else { "" }
            Add-DownloadManifestEntry -CatalogId $s.id -Model $s.model -ModelPath $modelAbs -MmprojPath $mmAbs -SizeBytes ([long]$s.size_bytes)
        }
    }

    Write-Host ""
    if ($failCount -eq 0) {
        Write-Host "[$okCount OK / $failCount FAIL] Done. Run 'calibr discover' to include them." -ForegroundColor Green
    } else {
        Write-Host "[$okCount OK / $failCount FAIL] Some downloads failed. Possible causes:" -ForegroundColor Yellow
        Write-Host "  - Repo moved or file renamed on HuggingFace -> edit models_catalog.json"
        Write-Host "  - Model requires accepting a license (Gemma) -> log into HF and accept, then retry"
        Write-Host "  - Network issue -> retry, or use 'huggingface-cli download' manually"
    }
}


