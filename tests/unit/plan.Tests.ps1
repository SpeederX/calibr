# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Test-CtxAllowedForModel" {
    It "allows any ctx when both caps are 0" {
        Assert-True (Test-CtxAllowedForModel -Ctx 163840 -GlobalCap 0 -PerModelCap 0)
    }
    It "allows ctx equal to the global cap" {
        Assert-True (Test-CtxAllowedForModel -Ctx 262144 -GlobalCap 262144 -PerModelCap 0)
    }
    It "rejects ctx above the global cap" {
        Assert-False (Test-CtxAllowedForModel -Ctx 524288 -GlobalCap 262144 -PerModelCap 0)
    }
    It "rejects ctx above a per-model 128k cap" {
        # The bug case from the user's test: Gemma 4 E2B reports max 128000,
        # so the 131072 candidate must be skipped even though the global cap
        # (262144) allows it.
        Assert-False (Test-CtxAllowedForModel -Ctx 131072 -GlobalCap 262144 -PerModelCap 128000)
    }
    It "allows ctx within both caps" {
        Assert-True (Test-CtxAllowedForModel -Ctx 65536 -GlobalCap 262144 -PerModelCap 128000)
    }
    It "ignores the per-model cap when it is 0 (user-owned model fallback)" {
        Assert-True (Test-CtxAllowedForModel -Ctx 163840 -GlobalCap 262144 -PerModelCap 0)
    }
}

Exit-WithResults


