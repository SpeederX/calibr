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

Describe "Adaptive offload adapter" {
    It "honors the explicit TypeScript calibration opt-out" {
        $old = $env:CALIBR_TS_OFFLOAD_CALIBRATION
        try {
            $env:CALIBR_TS_OFFLOAD_CALIBRATION = '0'
            Assert-Equal $null (Resolve-TsOffloadCalibrationScript)
        } finally {
            if ($null -eq $old) {
                Remove-Item Env:\CALIBR_TS_OFFLOAD_CALIBRATION -ErrorAction SilentlyContinue
            } else {
                $env:CALIBR_TS_OFFLOAD_CALIBRATION = $old
            }
        }
    }

    It "preserves a quoted base argument as one token" {
        $args = @(ConvertTo-OffloadArgumentList '--flash-attn auto --path "C:\model files\x"')
        Assert-Equal 4 $args.Count
        Assert-Equal "C:\model files\x" $args[3]
    }

    It "keeps a documented conservative raw-engine fallback" {
        $layers = @(Get-FallbackOffloadLayers)
        Assert-Equal 5 $layers.Count
        Assert-Equal 20 $layers[0]
        Assert-Equal 36 $layers[4]
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
        Assert-True ($prefill.label -match "prefill=32768")
        Assert-True ($kvFill.label -match "kvfill=49152")
    }

    It "records adaptive calibration provenance" {
        $calibration = @{
            calibrated = $true
            predicted_fit_layers = 27
            verified_fit_layers = 26
            first_spill_layers = 27
            probe_count = 3
        }
        $item = New-PlanItem -meta (_meta) -sweep "offload" -level "middle" `
            -extraArgs "--gpu-layers 27 --fit off" -label "ngl_27" -idx 1 `
            -Calibration $calibration -CalibrationId "abc123" -FitOffset 1

        Assert-Equal "adaptive-offload" $item.planning_mode
        Assert-Equal "abc123" $item.calibration_id
        Assert-Equal 26 $item.verified_fit_layers
        Assert-Equal 1 $item.fit_offset
    }
}

Describe "Workload profile expansion" {
    It "drops targets that would collide with generation reserve" {
        $cfg = @{
            bench = @{ n_predict = 128 }
            planning = @{
                workload_sweeps = @{
                    prefill_tokens = @(512, 8192, 131072)
                    kv_fill_ratios = @(0.25, 0.9, 0.99)
                    context_reserve_tokens = 512
                }
            }
        }
        $profiles = @(Get-WorkloadProfilesForContext -ContextSize 16384 -Config $cfg -Mode "all")
        Assert-Equal 4 $profiles.Count
        Assert-Equal 512 $profiles[0].prefill_tokens
        Assert-Equal 8192 $profiles[1].prefill_tokens
        Assert-Equal 4096 $profiles[2].kv_fill_tokens
        Assert-Equal 14745 $profiles[3].kv_fill_tokens
    }
}

Exit-WithResults


