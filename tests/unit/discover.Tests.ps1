# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Invoke-DenseOverrideFilter" {
    It "flips is_moe to false when the model is on the override list" {
        $m = @{ model = "something-A100B-special"; is_moe = $true }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides @("something-A100B-special")
        Assert-False $r.is_moe
    }
    It "leaves is_moe untouched when the model is not on the list" {
        $m = @{ model = "Qwen3.6-35B-A3B"; is_moe = $true }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides @("OtherFamily")
        Assert-True $r.is_moe "real MoE model must keep is_moe=true"
    }
    It "leaves is_moe untouched when it was already false" {
        $m = @{ model = "Qwen3.5-9B"; is_moe = $false }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides @("Qwen3.5-9B")
        Assert-False $r.is_moe "dense model must stay dense"
    }
    It "is a no-op when denseOverrides is null" {
        $m = @{ model = "Qwen3.6-35B-A3B"; is_moe = $true }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides $null
        Assert-True $r.is_moe
    }
    It "is a no-op when denseOverrides is empty" {
        $m = @{ model = "Qwen3.6-35B-A3B"; is_moe = $true }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides @()
        Assert-True $r.is_moe
    }
    It "matches exact case-sensitively" {
        $m = @{ model = "Qwen3.6-35B-A3B"; is_moe = $true }
        $r = Invoke-DenseOverrideFilter -meta $m -denseOverrides @("qwen3.6-35b-a3b")
        Assert-True $r.is_moe "case mismatch must NOT trigger the override"
    }
}

Describe "Multi-shard GGUF discovery" {
    It "recognizes only the first shard as the model entry point" {
        $first = Get-GgufShardIdentity "Model-UD-Q3_K_XL-00001-of-00003.gguf"
        $second = Get-GgufShardIdentity "Model-UD-Q3_K_XL-00002-of-00003.gguf"
        Assert-Equal "Model-UD-Q3_K_XL" $first.base
        Assert-Equal 1 $first.index
        Assert-Equal 3 $first.total
        Assert-Equal 2 $second.index
        Assert-Equal $null (Get-GgufShardIdentity "Model-Q4_K_M.gguf")
    }

    It "aggregates shard size while preserving model and variant parsing" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-shards-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
            $one = Join-Path $tmp "Qwen3.5-122B-A10B-UD-Q3_K_XL-00001-of-00002.gguf"
            $two = Join-Path $tmp "Qwen3.5-122B-A10B-UD-Q3_K_XL-00002-of-00002.gguf"
            [System.IO.File]::WriteAllBytes($one, [byte[]]::new(1024))
            [System.IO.File]::WriteAllBytes($two, [byte[]]::new(2048))
            $files = @(Get-ChildItem -LiteralPath $tmp -Filter "*.gguf")
            $meta = Get-ModelMetadata -path $one -ShardFiles $files
            Assert-Equal "Qwen3.5-122B-A10B" $meta.model
            Assert-Equal "UD-Q3_K_XL" $meta.variant
            Assert-True $meta.is_moe
            Assert-Equal 3072 $meta.size_bytes
            Assert-Equal 2 $meta.shard_count
            Assert-Equal 2 $meta.shard_paths.Count
            Assert-Equal $one $meta.path
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "uses GGUF expert tensors to identify MoE models whose names lack A3B notation" {
        Assert-True (Test-GgufMetadataIsMoe -Metadata @{ expert_tensor_bytes = 1024 })
        Assert-False (Test-GgufMetadataIsMoe -Metadata @{ expert_tensor_bytes = 0 })
    }
}


Describe "Find-MmprojSharedAcrossModels" {
    It "returns no warnings for an empty catalog" {
        $r = Find-MmprojSharedAcrossModels -catalog @()
        Assert-Equal 0 $r.Count
    }
    It "returns no warnings when a single model has its own mmproj" {
        $cat = @(@{ model = "A"; mmproj = "C:\m\mmproj.gguf" })
        $r = Find-MmprojSharedAcrossModels -catalog $cat
        Assert-Equal 0 $r.Count
    }
    It "flags two distinct models that share the same mmproj path" {
        # The historical Gemma 4 E2B vs E4B clash. Both .gguf land in the
        # same folder, both reference 'mmproj-F16.gguf', and only one is
        # physically present on disk after the second download overwrites
        # the first.
        $cat = @(
            @{ model = "Gemma-4-E2B"; mmproj = "C:\g\mmproj.gguf" }
            @{ model = "Gemma-4-E4B"; mmproj = "C:\g\mmproj.gguf" }
        )
        $r = Find-MmprojSharedAcrossModels -catalog $cat
        Assert-Equal 1 $r.Count
        Assert-Equal "C:\g\mmproj.gguf" $r[0].mmproj
        Assert-Equal 2 $r[0].models.Count
    }
    It "does NOT flag two variants of the same model sharing an mmproj" {
        # e.g. Qwen3.5-2B-UD-Q4_K_XL and Qwen3.5-2B-BF16 in the same folder.
        # Both have model='Qwen3.5-2B' (variant differs but model name is
        # the same), so the mmproj IS valid for both - same vision encoder.
        # Flagging this would spam the user about a non-bug.
        $cat = @(
            @{ model = "Qwen3.5-2B"; variant = "UD-Q4_K_XL"; mmproj = "C:\q\mmproj.gguf" }
            @{ model = "Qwen3.5-2B"; variant = "BF16";       mmproj = "C:\q\mmproj.gguf" }
        )
        $r = Find-MmprojSharedAcrossModels -catalog $cat
        Assert-Equal 0 $r.Count
    }
    It "flags only the shared group in a mixed catalog" {
        $cat = @(
            @{ model = "Gemma-4-E2B"; mmproj = "C:\shared\mmproj.gguf" }
            @{ model = "Gemma-4-E4B"; mmproj = "C:\shared\mmproj.gguf" }
            @{ model = "Solo";        mmproj = "C:\solo\mmproj.gguf" }
        )
        $r = Find-MmprojSharedAcrossModels -catalog $cat
        Assert-Equal 1 $r.Count
        Assert-Equal "C:\shared\mmproj.gguf" $r[0].mmproj
    }
}

Describe "Remove-PhantomEntries" {
    function _readArr($path) { return @(Get-Content $path -Raw | ConvertFrom-Json) }

    It "prunes catalog/plan/downloads entries whose model file is gone" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-phantom-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $real    = Join-Path $tmp "real.gguf"; Set-Content -LiteralPath $real -Value "x"
        $missing = Join-Path $tmp "ghost.gguf"   # never created

        $origCat = $script:CALIBR_CATALOG; $origPlan = $script:CALIBR_PLAN; $origDl = $script:CALIBR_DOWNLOADS
        try {
            $script:CALIBR_CATALOG   = Join-Path $tmp "catalog.json"
            $script:CALIBR_PLAN      = Join-Path $tmp "plan.json"
            $script:CALIBR_DOWNLOADS = Join-Path $tmp "downloads.json"

            @(@{ model="Real"; path=$real }, @{ model="Ghost"; path=$missing }) | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $script:CALIBR_CATALOG
            @(@{ id="r"; model_path=$real }, @{ id="g"; model_path=$missing }) | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $script:CALIBR_PLAN
            @(@{ model="Ghost"; model_path=$missing }) | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $script:CALIBR_DOWNLOADS

            $removed = Remove-PhantomEntries

            Assert-Equal 1 $removed "one catalog model removed"
            $cat = _readArr $script:CALIBR_CATALOG
            Assert-Equal 1 $cat.Count "catalog keeps only the real model"
            Assert-Equal "Real" $cat[0].model
            Assert-Equal 1 (_readArr $script:CALIBR_PLAN).Count "plan keeps only the real config"
            Assert-Equal 0 (_readArr $script:CALIBR_DOWNLOADS).Count "downloads drops the phantom (valid empty array)"
        } finally {
            $script:CALIBR_CATALOG = $origCat; $script:CALIBR_PLAN = $origPlan; $script:CALIBR_DOWNLOADS = $origDl
            Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
        }
    }

    It "leaves a fully-present index untouched (returns 0)" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-phantom-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $real = Join-Path $tmp "real.gguf"; Set-Content -LiteralPath $real -Value "x"
        $origCat = $script:CALIBR_CATALOG; $origPlan = $script:CALIBR_PLAN; $origDl = $script:CALIBR_DOWNLOADS
        try {
            $script:CALIBR_CATALOG   = Join-Path $tmp "catalog.json"
            $script:CALIBR_PLAN      = Join-Path $tmp "plan.json"
            $script:CALIBR_DOWNLOADS = Join-Path $tmp "downloads.json"
            @(@{ model="Real"; path=$real }) | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $script:CALIBR_CATALOG
            @(@{ id="r"; model_path=$real }) | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $script:CALIBR_PLAN
            '[]' | Out-File -Encoding utf8 $script:CALIBR_DOWNLOADS
            Assert-Equal 0 (Remove-PhantomEntries) "nothing removed when all files exist"
        } finally {
            $script:CALIBR_CATALOG = $origCat; $script:CALIBR_PLAN = $origPlan; $script:CALIBR_DOWNLOADS = $origDl
            Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
        }
    }
}

Describe "Get-GgufHeaderMetadata" {
    function Write-GgufString($Writer, [string]$Value) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        $Writer.Write([uint64]$bytes.Length)
        $Writer.Write($bytes)
    }

    function Write-GgufTensorInfo($Writer, [string]$Name, [uint64]$Offset, [uint32]$Type = 0) {
        Write-GgufString $Writer $Name
        $Writer.Write([uint32]1) # n_dims
        $Writer.Write([uint64]16)
        $Writer.Write($Type) # storage is inferred from offsets, including unknown future types
        $Writer.Write($Offset)
    }

    It "reads architecture and context length from a minimal GGUF header" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-gguf-" + [guid]::NewGuid().ToString('N') + ".gguf")
        $fs = $null
        $bw = $null
        try {
            $fs = [System.IO.File]::Open($tmp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
            $bw = [System.IO.BinaryWriter]::new($fs)
            $bw.Write([System.Text.Encoding]::ASCII.GetBytes("GGUF"))
            $bw.Write([uint32]3) # version
            $bw.Write([uint64]0) # tensor_count
            $bw.Write([uint64]2) # kv_count

            Write-GgufString $bw "general.architecture"
            $bw.Write([uint32]8) # string
            Write-GgufString $bw "llama"

            Write-GgufString $bw "llama.context_length"
            $bw.Write([uint32]4) # uint32
            $bw.Write([uint32]32768)

            $bw.Dispose(); $bw = $null
            $fs.Dispose(); $fs = $null

            $meta = Get-GgufHeaderMetadata -Path $tmp
            Assert-Equal "llama" $meta.architecture
            Assert-Equal 32768 $meta.context_length
        } finally {
            if ($bw) { $bw.Dispose() }
            if ($fs) { $fs.Dispose() }
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    It "aggregates aligned tensor storage by block, global, and expert tensors" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-gguf-tensors-" + [guid]::NewGuid().ToString('N') + ".gguf")
        $fs = $null
        $bw = $null
        try {
            $fs = [System.IO.File]::Open($tmp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
            $bw = [System.IO.BinaryWriter]::new($fs)
            $bw.Write([System.Text.Encoding]::ASCII.GetBytes("GGUF"))
            $bw.Write([uint32]3)
            $bw.Write([uint64]3) # tensor_count
            $bw.Write([uint64]4) # kv_count

            Write-GgufString $bw "general.architecture"
            $bw.Write([uint32]8); Write-GgufString $bw "llama"
            Write-GgufString $bw "llama.context_length"
            $bw.Write([uint32]4); $bw.Write([uint32]32768)
            Write-GgufString $bw "llama.block_count"
            $bw.Write([uint32]4); $bw.Write([uint32]2)
            Write-GgufString $bw "general.alignment"
            $bw.Write([uint32]4); $bw.Write([uint32]32)

            Write-GgufTensorInfo $bw "blk.0.attn_q.weight" ([uint64]0)
            Write-GgufTensorInfo $bw "blk.1.ffn_gate_exps.weight" ([uint64]64) ([uint32]999)
            Write-GgufTensorInfo $bw "token_embd.weight" ([uint64]128)

            $padding = (32 - ($fs.Position % 32)) % 32
            if ($padding -gt 0) { $bw.Write([byte[]]::new([int]$padding)) }
            $bw.Write([byte[]]::new(160))
            $bw.Dispose(); $bw = $null
            $fs.Dispose(); $fs = $null

            $meta = Get-GgufHeaderMetadata -Path $tmp
            Assert-Equal 2 $meta.block_count
            Assert-Equal 3 $meta.tensor_count
            Assert-Equal 160 $meta.tensor_bytes
            Assert-Equal 32 $meta.global_tensor_bytes
            Assert-Equal 64 $meta.expert_tensor_bytes
            Assert-Equal 2 $meta.block_tensor_bytes.Count
            Assert-Equal 64 $meta.block_tensor_bytes[0].bytes
            Assert-Equal 0 $meta.block_tensor_bytes[0].expert_bytes
            Assert-Equal 64 $meta.block_tensor_bytes[1].bytes
            Assert-Equal 64 $meta.block_tensor_bytes[1].expert_bytes
        } finally {
            if ($bw) { $bw.Dispose() }
            if ($fs) { $fs.Dispose() }
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

Exit-WithResults

