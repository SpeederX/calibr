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
    if ($null -eq $preset) { return ,@($catalog) }
    if ($preset.models -is [string] -and $preset.models -eq '*') { return ,@($catalog) }
    $ids = @($preset.models)
    return ,@($catalog | Where-Object { $ids -contains $_.id })
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

function Invoke-HFDownload {
    # Downloads a single file from HuggingFace using HttpWebRequest with a
    # manual byte-counting loop, so we can emit `[dlprog]` progress markers
    # the CLI parses for the live download bar. Invoke-WebRequest is fully
    # synchronous in PS 5.1 with no usable per-byte progress signal (the
    # built-in progress UI is unusably slow), hence the lower-level path.
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
            Write-TraceEvent -Action "start > download model" -Status "skipped" `
                -Message "start > download model skipped: file already present" `
                -Details @{ repo = $Repo; file = $File; path = $DestPath; bytes = $actual }
            return $true
        }
        if ($ExpectedBytes -eq 0) {
            Write-Host ("  [skip] already present: $DestPath ({0})" -f (Format-HumanSize $actual)) -ForegroundColor DarkGray
            Write-TraceEvent -Action "start > download model" -Status "skipped" `
                -Message "start > download model skipped: file already present" `
                -Details @{ repo = $Repo; file = $File; path = $DestPath; bytes = $actual }
            return $true
        }
        Write-Host ("  [resume] partial file at $DestPath ({0}/{1}); -Force to restart" -f (Format-HumanSize $actual), (Format-HumanSize $ExpectedBytes)) -ForegroundColor Yellow
    }

    Write-Host "  [download] $url" -ForegroundColor Cyan
    Write-Host "             -> $DestPath"
    # Phase marker so the CLI switches the per-config flow widget to the
    # download bar. Match in RunView.tsx PHASE_RE.
    Write-Host "[phase] downloading"
    Write-TraceEvent -Action "start > download model" -Status "started" `
        -Message "start > download model started" `
        -Details @{ repo = $Repo; file = $File; url = $url; path = $DestPath; expectedBytes = $ExpectedBytes }

    $req = $null
    $resp = $null
    $rspStream = $null
    $fileStream = $null
    try {
        # HF requires TLS 1.2+. PS 5.1's default SecurityProtocol is Ssl3+Tls.
        # Without this the HttpWebRequest throws on the TLS handshake.
        [System.Net.ServicePointManager]::SecurityProtocol = `
            [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.UserAgent = "calibr/0.1 (+https://github.com/SpeederX/calibr)"
        $req.AllowAutoRedirect = $true   # HF redirects to the CDN
        $req.Timeout = 30000             # 30 s for connection / TLS handshake
        $req.ReadWriteTimeout = 60000    # 60 s for any single read

        $resp = $req.GetResponse()
        $total = [long]$resp.ContentLength
        if ($total -le 0 -and $ExpectedBytes -gt 0) { $total = $ExpectedBytes }

        $rspStream = $resp.GetResponseStream()
        $fileStream = [System.IO.File]::Create($DestPath)

        $bufferSize = 65536
        $buffer = New-Object byte[] $bufferSize
        $totalBytes = 0L
        $start = [System.Diagnostics.Stopwatch]::StartNew()
        $lastEmitMs = 0L
        $lastEmitBytes = 0L
        $inv = [System.Globalization.CultureInfo]::InvariantCulture

        while (($read = $rspStream.Read($buffer, 0, $bufferSize)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $totalBytes += $read

            $nowMs = $start.ElapsedMilliseconds
            if (($nowMs - $lastEmitMs) -ge 200) {
                $deltaMs = $nowMs - $lastEmitMs
                $deltaBytes = $totalBytes - $lastEmitBytes
                # Instant MiB/s. InvariantCulture so '.' is the decimal point
                # even on Italian Windows (Number("23,4") in JS is NaN).
                $speed = if ($deltaMs -gt 0) { ($deltaBytes / 1048576.0) * 1000.0 / $deltaMs } else { 0.0 }
                $speedStr = $speed.ToString("F2", $inv)
                Write-Host ("[dlprog] bytes={0} total={1} speed_mibps={2} elapsed_ms={3}" -f $totalBytes, $total, $speedStr, $nowMs)
                $lastEmitMs = $nowMs
                $lastEmitBytes = $totalBytes
            }
        }
        $fileStream.Close(); $fileStream = $null
        $rspStream.Close(); $rspStream = $null
        $resp.Close(); $resp = $null

        # Final emit so the CLI lands on exactly 100% rather than the last
        # interior tick. elapsed_ms is meaningful for the "avg speed" line.
        $avgSpeed = if ($start.ElapsedMilliseconds -gt 0) {
            ($totalBytes / 1048576.0) * 1000.0 / $start.ElapsedMilliseconds
        } else { 0.0 }
        $avgStr = $avgSpeed.ToString("F2", $inv)
        Write-Host ("[dlprog] bytes={0} total={1} speed_mibps={2} elapsed_ms={3}" -f $totalBytes, $totalBytes, $avgStr, $start.ElapsedMilliseconds)
        Write-Host ("[dldone] bytes={0} elapsed_ms={1} avg_mibps={2}" -f $totalBytes, $start.ElapsedMilliseconds, $avgStr)

        Write-Host ("  [done]  {0} in {1}s ({2} MiB/s avg)" -f (Format-HumanSize $totalBytes), [math]::Round($start.ElapsedMilliseconds / 1000.0, 1), $avgStr) -ForegroundColor Green
        Write-TraceEvent -Action "start > download model" -Status "completed" `
            -Message "start > download model completed" `
            -Details @{ repo = $Repo; file = $File; path = $DestPath; bytes = $totalBytes; elapsedMs = $start.ElapsedMilliseconds; avgMibps = $avgStr }
        return $true
    } catch {
        Write-Host ("  [FAIL]  {0}" -f $_.Exception.Message) -ForegroundColor Red
        Write-TraceEvent -Action "start > download model" -Status "failed" `
            -Message "start > download model failed" `
            -Details @{ repo = $Repo; file = $File; url = $url; path = $DestPath; error = $_.Exception.Message }
        # Best-effort cleanup of a partial file that the caller can't recover.
        if ($fileStream) { try { $fileStream.Close() } catch {} }
        if ((Test-Path $DestPath) -and (Get-Item $DestPath).Length -eq 0) {
            Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
        }
        return $false
    } finally {
        if ($fileStream) { try { $fileStream.Dispose() } catch {} }
        if ($rspStream)  { try { $rspStream.Dispose() }  catch {} }
        if ($resp)       { try { $resp.Close() }         catch {} }
    }
}

function Invoke-FetchModels {
    $cfg = Get-Config
    $samples = Get-ModelCatalog

    # Filter by -Model or -CatalogId if provided
    $filtered = $samples
    if ($CatalogId)  {
        # Accept comma-separated lists same as the 'all' dispatcher so the
        # CLI's CustomBenchView can pass a multi-pick selection here too.
        $idPatterns = @(($CatalogId -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $filtered = $filtered | Where-Object {
            foreach ($pat in $idPatterns) { if ($_.id -like $pat) { return $true } }
            return $false
        }
    }
    if ($Model)    { $filtered = $filtered | Where-Object { $_.model -match $Model } }

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


