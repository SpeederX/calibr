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

Describe "Planning policy" {
    It "normalizes a context-size CSV once at the boundary" {
        $sizes = @(ConvertTo-ContextSizeList -Value "16384, 32768, nope, 65536")
        Assert-Equal 3 $sizes.Count
        Assert-Equal 16384 $sizes[0]
        Assert-Equal 65536 $sizes[2]
    }

    It "stores preset limits as explicit planner input" {
        $policy = New-PlanningPolicy -MaxContext 131072 -ContextSizes @(16384, 32768)
        Assert-Equal 131072 $policy.max_context
        Assert-Equal 2 $policy.context_sizes.Count
    }
}

Describe "Plan workload identity" {
    function _meta {
        return @{
            path = "C:\models\model.gguf"
            model = "Model"
            variant = "Q4_K_M"
            series = "Series"
        }
    }

    It "keeps baseline ids compatible" {
        $item = New-PlanItem -meta (_meta) -sweep "context" -level "middle" `
            -extraArgs "--ctx-size 16384" -label "ctx=16384_kv=q8_0" -idx 1
        Assert-Equal "Model_Q4_K_M__ctx_16384_kv_q8_0" $item.id
        Assert-Equal "baseline" $item.workload_kind
    }

    It "makes prefill and KV-fill targets part of config identity" {
        $prefill = New-PlanItem -meta (_meta) -sweep "context" -level "middle" `
            -extraArgs "--ctx-size 65536" -label "ctx=65536_kv=q8_0" -idx 1 `
            -WorkloadKind "prefill" -PrefillTokens 32768
        $kvFill = New-PlanItem -meta (_meta) -sweep "context" -level "middle" `
            -extraArgs "--ctx-size 65536" -label "ctx=65536_kv=q8_0" -idx 1 `
            -WorkloadKind "kv-fill" -KvFillTokens 49152

        Assert-False ($prefill.id -eq $kvFill.id)
        Assert-True ($prefill.id -match "prefill_32768")
        Assert-True ($kvFill.id -match "kvfill_49152")
    }
}

Exit-WithResults


