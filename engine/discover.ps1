# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# SUBCOMMAND: discover
# ============================================================================
function Get-GgufShardIdentity {
    param([string]$FileName)
    if ($FileName -match '^(?<base>.+)-(?<index>\d{5})-of-(?<total>\d{5})\.gguf$') {
        return @{
            base = $Matches.base
            index = [int]$Matches.index
            total = [int]$Matches.total
        }
    }
    return $null
}

function Merge-GgufShardMetadata {
    param([object[]]$ShardFiles)
    $merged = @{
        architecture = $null
        context_length = $null
        block_count = $null
        tensor_count = 0
        tensor_data_offset = $null
        tensor_bytes = 0
        global_tensor_bytes = 0
        expert_tensor_bytes = 0
        block_tensor_bytes = @()
    }
    $blocks = @{}
    foreach ($shard in @($ShardFiles)) {
        $part = Get-GgufHeaderMetadata -Path $shard.FullName
        if (-not $merged.architecture -and $part.architecture) { $merged.architecture = $part.architecture }
        if (-not $merged.context_length -and $part.context_length) { $merged.context_length = $part.context_length }
        if (-not $merged.block_count -and $part.block_count) { $merged.block_count = $part.block_count }
        if (-not $merged.tensor_data_offset -and $part.tensor_data_offset) { $merged.tensor_data_offset = $part.tensor_data_offset }
        $merged.tensor_count += [int]$part.tensor_count
        $merged.tensor_bytes += [int64]$(if ($part.tensor_bytes) { $part.tensor_bytes } else { 0 })
        $merged.global_tensor_bytes += [int64]$(if ($part.global_tensor_bytes) { $part.global_tensor_bytes } else { 0 })
        $merged.expert_tensor_bytes += [int64]$(if ($part.expert_tensor_bytes) { $part.expert_tensor_bytes } else { 0 })
        foreach ($entry in @($part.block_tensor_bytes)) {
            $key = [int]$entry.block
            if (-not $blocks.ContainsKey($key)) { $blocks[$key] = @{ bytes = [int64]0; expert_bytes = [int64]0 } }
            $blocks[$key].bytes += [int64]$entry.bytes
            $blocks[$key].expert_bytes += [int64]$entry.expert_bytes
        }
    }
    $merged.block_tensor_bytes = @($blocks.Keys | Sort-Object | ForEach-Object {
        @{ block = [int]$_; bytes = [int64]$blocks[$_].bytes; expert_bytes = [int64]$blocks[$_].expert_bytes }
    })
    return $merged
}

function Test-GgufMetadataIsMoe {
    param($Metadata)
    return ([int64]$(if ($Metadata.expert_tensor_bytes) { $Metadata.expert_tensor_bytes } else { 0 }) -gt 0)
}

function Get-ModelMetadata {
    param([string]$path, [object[]]$ShardFiles = @())
    $file = Get-Item -LiteralPath $path
    $shards = if ($ShardFiles.Count -gt 0) { @($ShardFiles | Sort-Object Name) } else { @($file) }
    $shardIdentity = Get-GgufShardIdentity -FileName $file.Name
    $fname = if ($shardIdentity) { $shardIdentity.base } else { $file.BaseName }

    $variant = "unknown"
    $model   = $fname
    $variantPatterns = @(
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_XL)$',
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_M)$',
        '^(?<m>.+?)[\.\-](?<v>UD-Q\d+_K_S)$',
        '^(?<m>.+?)[\.\-](?<v>Q\d+_K_[A-Z]+)$',
        '^(?<m>.+?)[\.\-](?<v>Q\d+_\d+)$',
        '^(?<m>.+?)[\.\-](?<v>IQ\d+_[A-Z0-9_-]+)$',
        '^(?<m>.+?)[\.\-](?<v>BF16|F16|F32|(?i:MXFP4))$'
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

    $gguf = if ($shards.Count -gt 1) {
        Merge-GgufShardMetadata -ShardFiles $shards
    } else {
        Get-GgufHeaderMetadata -Path $file.FullName
    }
    if (Test-GgufMetadataIsMoe -Metadata $gguf) {
        $is_moe = $true
    }
    $curated = Get-CuratedMetadataForFile -FileName $file.Name
    [int64]$sizeBytes = ($shards | Measure-Object -Property Length -Sum).Sum

    return @{
        role       = "model"
        path       = $file.FullName
        name       = $file.Name
        size_bytes = $sizeBytes
        size_mib   = [int]($sizeBytes / 1MB)
        shard_count = $shards.Count
        shard_paths = @($shards | ForEach-Object { $_.FullName })
        model      = $model
        series     = $series
        variant    = $variant
        params_b   = $params_b
        is_moe     = $is_moe
        mmproj     = $mmproj
        dir        = $file.Directory.FullName
        gguf_architecture = $gguf.architecture
        gguf_context_length = $gguf.context_length
        gguf_block_count = $gguf.block_count
        gguf_tensor_count = $gguf.tensor_count
        gguf_tensor_data_offset = $gguf.tensor_data_offset
        gguf_tensor_bytes = $gguf.tensor_bytes
        gguf_global_tensor_bytes = $gguf.global_tensor_bytes
        gguf_expert_tensor_bytes = $gguf.expert_tensor_bytes
        gguf_block_tensor_bytes = $gguf.block_tensor_bytes
        reasoning_mode = $curated.reasoning_mode
        template_note = $curated.template_note
    }
}

function Resolve-TsGgufMetadataScript {
    if ($env:CALIBR_TS_GGUF_METADATA -eq '0') { return "" }
    if ($env:CALIBR_TS_GGUF_METADATA_SCRIPT -and (Test-Path -LiteralPath $env:CALIBR_TS_GGUF_METADATA_SCRIPT)) {
        return $env:CALIBR_TS_GGUF_METADATA_SCRIPT
    }
    $candidates = @(
        (Join-Path $script:CALIBR_ROOT "cli\dist\engine\discover\ggufMetadataCli.js"),
        (Join-Path (Split-Path $script:CALIBR_ROOT -Parent) "dist\engine\discover\ggufMetadataCli.js")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ""
}

function Read-TsGgufHeader {
    # Single-file GGUF header via the Node reader (@huggingface/gguf). Throws if
    # the build is missing - no PowerShell fallback.
    param([string]$Path)
    $reader = Resolve-TsGgufMetadataScript
    if (-not $reader) {
        throw "Node GGUF reader build not found. Run 'npm run build' in cli/ (expected dist/engine/discover/ggufMetadataCli.js)."
    }
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    $out = & $node $reader --path $Path 2>&1
    $json = @($out | Where-Object { $_ -and $_.ToString().TrimStart().StartsWith('{') } | Select-Object -Last 1)
    if ($json.Count -eq 0) { throw "Node GGUF reader produced no result for $Path" }
    return ConvertTo-Hashtable -obj ($json[0] | ConvertFrom-Json)
}

function Set-GgufHeaderCacheFromPaths {
    # Batch-read every header in one Node call and cache it by path so
    # Get-GgufHeaderMetadata becomes a lookup (no per-file spawn) during discover.
    param([string[]]$Paths)
    if ($null -eq $script:GgufHeaderCache) { $script:GgufHeaderCache = @{} }
    if (-not $Paths -or $Paths.Count -eq 0) { return }
    $reader = Resolve-TsGgufMetadataScript
    if (-not $reader) {
        throw "Node GGUF reader build not found. Run 'npm run build' in cli/ (expected dist/engine/discover/ggufMetadataCli.js)."
    }
    $payloadPath = Join-Path $script:CALIBR_DATA_DIR ("gguf-paths-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $node = if ($env:CALIBR_NODE) { $env:CALIBR_NODE } else { 'node' }
    try {
        # Use an object wrapper instead of a bare array: Windows PowerShell 5.1
        # serializes a single-element array as a scalar string, which would make
        # the Node side iterate characters instead of paths. The CLI accepts both
        # the wrapped shape and the historical bare array for compatibility.
        [System.IO.File]::WriteAllText(
            $payloadPath,
            (ConvertTo-Json -InputObject @{ paths = @($Paths) } -Depth 3),
            (New-Object System.Text.UTF8Encoding($false))
        )
        $out = & $node $reader --paths-file $payloadPath 2>&1
        $json = @($out | Where-Object { $_ -and $_.ToString().TrimStart().StartsWith('{') } | Select-Object -Last 1)
        if ($json.Count -eq 0) { throw "Node GGUF batch reader produced no result" }
        $map = ConvertTo-Hashtable -obj ($json[0] | ConvertFrom-Json)
        foreach ($key in @($map.Keys)) { $script:GgufHeaderCache[$key] = $map[$key] }
    } finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-GgufHeaderMetadata {
    # GGUF header metadata via the Node reader. Invoke-Discover pre-populates
    # $script:GgufHeaderCache with one batch call; this returns the cached entry,
    # or reads the single file via Node on a cache miss.
    param([string]$Path)
    if ($script:GgufHeaderCache -and $script:GgufHeaderCache.ContainsKey($Path)) {
        return $script:GgufHeaderCache[$Path]
    }
    return (Read-TsGgufHeader -Path $Path)
}

function Get-CuratedMetadataForFile {
    param([string]$FileName)
    $out = @{ reasoning_mode = $null; template_note = $null }
    try {
        $entry = @(Get-ModelCatalog | Where-Object { $_.hf_file -ieq $FileName } | Select-Object -First 1)
        if ($entry.Count -gt 0) {
            $out.reasoning_mode = $entry[0].reasoning_mode
            $out.template_note = $entry[0].template_note
        }
    } catch { }
    return $out
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
    $script:GgufHeaderCache = @{}
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
        $ggufs = @(Get-ChildItem -LiteralPath $base -Filter "*.gguf" -Recurse -File -ErrorAction SilentlyContinue)
        # One batch Node call reads all headers up front; Get-GgufHeaderMetadata
        # then resolves from the cache (no per-file spawn).
        Set-GgufHeaderCacheFromPaths -Paths @($ggufs | ForEach-Object { $_.FullName })
        foreach ($f in $ggufs) {
            $skip = $false
            foreach ($ex in $cfg.exclude_patterns) {
                if ($f.Name -like $ex) { $skip = $true; break }
            }
            if ($skip) { continue }
            $shardIdentity = Get-GgufShardIdentity -FileName $f.Name
            $shardFiles = @()
            if ($shardIdentity) {
                if ($shardIdentity.index -ne 1) { continue }
                $escapedBase = [regex]::Escape($shardIdentity.base)
                $escapedTotal = $shardIdentity.total.ToString('D5')
                $shardFiles = @($ggufs | Where-Object {
                    $_.DirectoryName -eq $f.DirectoryName -and
                    $_.Name -match "^${escapedBase}-(\d{5})-of-${escapedTotal}\.gguf$"
                } | Sort-Object Name)
                if ($shardFiles.Count -ne $shardIdentity.total) {
                    Write-Warning ("incomplete GGUF shard set for {0}: found {1}/{2}; skipping" -f $shardIdentity.base, $shardFiles.Count, $shardIdentity.total)
                    continue
                }
            }
            $meta = Get-ModelMetadata -path $f.FullName -ShardFiles $shardFiles
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

function Remove-PhantomEntries {
    # Reconcile the on-disk index with disk truth: drop any catalog.json /
    # plan.json / downloads.json entry whose model .gguf is no longer present
    # (rotated away by auto-cleanup, deleted, or moved). Without this, a model
    # that was downloaded -> benched -> rotated leaves dangling references that
    # later surface as confusing "server didn't become ready" failures and a
    # model that looks selectable but can't run.
    #
    # Safe by construction: data/results/*.json (the historical leaderboard) is
    # NOT touched, so a rotated-and-benched model keeps its results even after
    # its catalog/plan entries are pruned. Returns the number of catalog models
    # removed (0 = nothing stale). Cheap: a few Test-Path calls.
    $exists = { param($p) $p -and (Test-Path -LiteralPath $p) }
    # Always serialize as a JSON ARRAY: PowerShell's ConvertTo-Json emits an
    # object for a single element and an empty string for @(), both of which
    # break the array-expecting readers (CLI + engine). [] for empty, wrapped
    # for one. Works on Windows PowerShell 5.1 (no -AsArray).
    $toArr = {
        param($a)
        $a = @($a)
        if ($a.Count -eq 0) { return '[]' }
        $j = $a | ConvertTo-Json -Depth 5
        if ($j.TrimStart() -notmatch '^\[') { $j = "[`n$j`n]" }
        return $j
    }
    $readArr = {
        param([string]$path)
        $raw = Get-Content $path -Raw | ConvertFrom-Json
        $items = @()
        if ($null -ne $raw) {
            foreach ($item in $raw) { $items += $item }
        }
        return $items
    }
    $removedModels = 0

    if (Test-Path $script:CALIBR_CATALOG) {
        try {
            $cat  = @(& $readArr $script:CALIBR_CATALOG)
            $keep = @($cat | Where-Object { & $exists $_.path })
            if ($keep.Count -ne $cat.Count) {
                $removedModels = $cat.Count - $keep.Count
                (& $toArr $keep) | Out-File -Encoding utf8 $script:CALIBR_CATALOG
            }
        } catch { }
    }

    if (Test-Path $script:CALIBR_PLAN) {
        try {
            $plan  = @(& $readArr $script:CALIBR_PLAN)
            $keepP = @($plan | Where-Object { & $exists $_.model_path })
            if ($keepP.Count -ne $plan.Count) {
                (& $toArr $keepP) | Out-File -Encoding utf8 $script:CALIBR_PLAN
            }
        } catch { }
    }

    if (Test-Path $script:CALIBR_DOWNLOADS) {
        try {
            $dl    = @(& $readArr $script:CALIBR_DOWNLOADS)
            $keepD = @($dl | Where-Object { & $exists $_.model_path })
            if ($keepD.Count -ne $dl.Count) {
                (& $toArr $keepD) | Out-File -Encoding utf8 $script:CALIBR_DOWNLOADS
            }
        } catch { }
    }

    return $removedModels
}

function Find-MmprojSharedAcrossModels {
    # Pure: groups catalog entries by their paired mmproj path; returns an
    # array of @{mmproj; models} for every mmproj seen with more than one
    # distinct `model` name. Returns @() when nothing is shared. Two variants
    # of the same model (e.g. Qwen3.5-2B Q4_K_XL + BF16) that share an
    # mmproj are NOT flagged because the `model` field is identical - they
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


