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


