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

function Read-GgufValue {
    param($Reader, [int]$Type)
    switch ($Type) {
        0  { return [uint64]$Reader.ReadByte() }
        1  { return [int64]$Reader.ReadSByte() }
        2  { return [uint64]$Reader.ReadUInt16() }
        3  { return [int64]$Reader.ReadInt16() }
        4  { return [uint64]$Reader.ReadUInt32() }
        5  { return [int64]$Reader.ReadInt32() }
        6  { return [double]$Reader.ReadSingle() }
        7  { return [bool]$Reader.ReadByte() }
        8  {
            $len = [int]$Reader.ReadUInt64()
            $bytes = $Reader.ReadBytes($len)
            return [System.Text.Encoding]::UTF8.GetString($bytes)
        }
        9  {
            $itemType = [int]$Reader.ReadUInt32()
            $count = [int]$Reader.ReadUInt64()
            for ($i = 0; $i -lt $count; $i++) { [void](Read-GgufValue -Reader $Reader -Type $itemType) }
            return $null
        }
        10 { return $Reader.ReadUInt64() }
        11 { return $Reader.ReadInt64() }
        12 { return $Reader.ReadDouble() }
        default { throw "unknown GGUF value type $Type" }
    }
}

function Skip-GgufValue {
    param($Reader, [int]$Type)
    if (-not ('CalibrGgufReader' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.IO;

public static class CalibrGgufReader {
    public static void SkipValue(BinaryReader reader, uint type) {
        switch (type) {
            case 0: case 1: case 7: reader.BaseStream.Seek(1, SeekOrigin.Current); return;
            case 2: case 3: reader.BaseStream.Seek(2, SeekOrigin.Current); return;
            case 4: case 5: case 6: reader.BaseStream.Seek(4, SeekOrigin.Current); return;
            case 8:
                SkipBytes(reader, reader.ReadUInt64());
                return;
            case 9:
                uint itemType = reader.ReadUInt32();
                ulong count = reader.ReadUInt64();
                int width = FixedWidth(itemType);
                if (width > 0) {
                    SkipBytes(reader, checked(count * (ulong) width));
                } else {
                    for (ulong i = 0; i < count; i++) SkipValue(reader, itemType);
                }
                return;
            case 10: case 11: case 12: reader.BaseStream.Seek(8, SeekOrigin.Current); return;
            default: throw new InvalidDataException("Unknown GGUF value type " + type);
        }
    }

    private static int FixedWidth(uint type) {
        switch (type) {
            case 0: case 1: case 7: return 1;
            case 2: case 3: return 2;
            case 4: case 5: case 6: return 4;
            case 10: case 11: case 12: return 8;
            default: return 0;
        }
    }

    private static void SkipBytes(BinaryReader reader, ulong count) {
        if (count > long.MaxValue) throw new InvalidDataException("GGUF value is too large");
        reader.BaseStream.Seek((long) count, SeekOrigin.Current);
    }
}
"@
    }
    [CalibrGgufReader]::SkipValue($Reader, [uint32]$Type)
}
function Get-GgufHeaderMetadata {
    param([string]$Path)
    $out = @{
        architecture = $null
        context_length = $null
        block_count = $null
        tensor_count = 0
        tensor_data_offset = $null
        tensor_bytes = $null
        global_tensor_bytes = $null
        expert_tensor_bytes = $null
        block_tensor_bytes = @()
    }
    $fs = $null
    $br = $null
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $br = [System.IO.BinaryReader]::new($fs)
        $magic = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        if ($magic -ne "GGUF") { return $out }
        [void]$br.ReadUInt32() # version
        $tensorCountRaw = $br.ReadUInt64()
        if ($tensorCountRaw -gt [int]::MaxValue) { return $out }
        $tensorCount = [int]$tensorCountRaw
        $out.tensor_count = $tensorCount
        $kvCount = [int]$br.ReadUInt64()
        $alignment = 32
        for ($i = 0; $i -lt $kvCount; $i++) {
            $keyLen = [int]$br.ReadUInt64()
            $key = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes($keyLen))
            $type = [int]$br.ReadUInt32()
            $wanted = ($key -eq "general.architecture" -or $key -eq "general.alignment" -or
                $key -match '\.context_length$' -or $key -match '\.block_count$')
            if (-not $wanted) {
                Skip-GgufValue -Reader $br -Type $type
                continue
            }
            $value = Read-GgufValue -Reader $br -Type $type
            if ($key -eq "general.architecture" -and $value) { $out.architecture = [string]$value }
            if ($key -match '\.context_length$' -and $null -ne $value) { $out.context_length = [int64]$value }
            if ($key -match '\.block_count$' -and $null -ne $value) { $out.block_count = [int]$value }
            if ($key -eq "general.alignment" -and $null -ne $value -and [int]$value -gt 0) { $alignment = [int]$value }
        }

        # Offset deltas give the stored tensor span, including alignment, and
        # avoid duplicating ggml's evolving quantization type table.
        $tensors = @()
        for ($i = 0; $i -lt $tensorCount; $i++) {
            $nameLen = [int]$br.ReadUInt64()
            $name = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes($nameLen))
            $nDims = [int]$br.ReadUInt32()
            for ($d = 0; $d -lt $nDims; $d++) { [void]$br.ReadUInt64() }
            [void]$br.ReadUInt32() # ggml_type
            $tensors += @{ name = $name; offset = [uint64]$br.ReadUInt64() }
        }

        $directoryEnd = [int64]$fs.Position
        $padding = ($alignment - ($directoryEnd % $alignment)) % $alignment
        $dataStart = $directoryEnd + $padding
        if ($dataStart -gt $fs.Length) { return $out }
        $out.tensor_data_offset = $dataStart

        $ordered = @($tensors | Sort-Object { [uint64]$_.offset })
        $blockBytes = @{}
        $blockExpertBytes = @{}
        [int64]$globalBytes = 0
        [int64]$expertBytes = 0
        [int64]$tensorBytes = 0
        for ($i = 0; $i -lt $ordered.Count; $i++) {
            $current = $ordered[$i]
            [int64]$start = $dataStart + [int64]$current.offset
            [int64]$end = if ($i + 1 -lt $ordered.Count) { $dataStart + [int64]$ordered[$i + 1].offset } else { $fs.Length }
            if ($start -lt $dataStart -or $end -lt $start -or $end -gt $fs.Length) { continue }
            [int64]$bytes = $end - $start
            $tensorBytes += $bytes

            $blockIndex = $null
            if ([string]$current.name -match '(?:^|\.)blk\.(\d+)(?:\.|$)') { $blockIndex = [int]$Matches[1] }
            $isExpert = ([string]$current.name -match '(?:ffn.*_exps|experts?)')
            if ($null -ne $blockIndex) {
                if (-not $blockBytes.ContainsKey($blockIndex)) { $blockBytes[$blockIndex] = [int64]0 }
                $blockBytes[$blockIndex] = [int64]$blockBytes[$blockIndex] + $bytes
                if ($isExpert) {
                    if (-not $blockExpertBytes.ContainsKey($blockIndex)) { $blockExpertBytes[$blockIndex] = [int64]0 }
                    $blockExpertBytes[$blockIndex] = [int64]$blockExpertBytes[$blockIndex] + $bytes
                }
            } else { $globalBytes += $bytes }
            if ($isExpert) { $expertBytes += $bytes }
        }

        $out.tensor_bytes = $tensorBytes
        $out.global_tensor_bytes = $globalBytes
        $out.expert_tensor_bytes = $expertBytes
        $out.block_tensor_bytes = @($blockBytes.Keys | Sort-Object | ForEach-Object {
            @{ block = [int]$_; bytes = [int64]$blockBytes[$_]; expert_bytes = if ($blockExpertBytes.ContainsKey($_)) { [int64]$blockExpertBytes[$_] } else { [int64]0 } }
        })
    } catch {
        return $out
    } finally {
        if ($br) { $br.Dispose() }
        if ($fs) { $fs.Dispose() }
    }
    return $out
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


