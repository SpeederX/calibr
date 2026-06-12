# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

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

    $gguf = Get-GgufHeaderMetadata -Path $file.FullName
    $curated = Get-CuratedMetadataForFile -FileName $file.Name

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
        gguf_architecture = $gguf.architecture
        gguf_context_length = $gguf.context_length
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

function Get-GgufHeaderMetadata {
    param([string]$Path)
    $out = @{ architecture = $null; context_length = $null }
    $fs = $null
    $br = $null
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $br = [System.IO.BinaryReader]::new($fs)
        $magic = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        if ($magic -ne "GGUF") { return $out }
        [void]$br.ReadUInt32() # version
        [void]$br.ReadUInt64() # tensor_count
        $kvCount = [int]$br.ReadUInt64()
        for ($i = 0; $i -lt $kvCount; $i++) {
            $keyLen = [int]$br.ReadUInt64()
            $key = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes($keyLen))
            $type = [int]$br.ReadUInt32()
            $value = Read-GgufValue -Reader $br -Type $type
            if ($key -eq "general.architecture" -and $value) { $out.architecture = [string]$value }
            if ($key -match '\.context_length$' -and $null -ne $value) { $out.context_length = [int64]$value }
            if ($out.architecture -and $out.context_length) { break }
        }
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


