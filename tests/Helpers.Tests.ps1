# Unit tests for the dot-path / type-coercion helpers in llm-lab.ps1.
# Run via:  .\tests\run-tests.ps1
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\..\llm-lab.ps1"

Describe "Get-NestedValue" {
    It "returns @{found=true; value=...} on a hit" {
        $r = Get-NestedValue -obj @{ a = @{ b = 42 } } -path "a.b"
        Assert-True  $r.found
        Assert-Equal 42 $r.value
    }
    It "returns found=false on a miss" {
        $r = Get-NestedValue -obj @{ a = @{ b = 42 } } -path "a.c"
        Assert-False $r.found
    }
    It "returns found=false when descending into a non-hashtable" {
        $r = Get-NestedValue -obj @{ a = "leaf" } -path "a.b"
        Assert-False $r.found
    }
    It "handles single-segment paths" {
        $r = Get-NestedValue -obj @{ a = 1 } -path "a"
        Assert-True  $r.found
        Assert-Equal 1 $r.value
    }
}

Describe "Set-NestedValue" {
    It "overwrites an existing leaf" {
        $h = @{ a = @{ b = 1 } }
        Set-NestedValue -obj $h -path "a.b" -value 99
        Assert-Equal 99 $h.a.b
    }
    It "creates intermediate hashtables along the way" {
        $h = @{}
        Set-NestedValue -obj $h -path "x.y.z" -value "ok"
        Assert-Equal "ok" $h.x.y.z
        Assert-True ($h.x -is [hashtable])
        Assert-True ($h.x.y -is [hashtable])
    }
}

Describe "Remove-NestedValue" {
    It "removes the leaf and returns true" {
        $h = @{ a = @{ b = 1; c = 2 } }
        $ok = Remove-NestedValue -obj $h -path "a.b"
        Assert-True $ok
        Assert-False $h.a.ContainsKey("b")
        Assert-True  $h.a.ContainsKey("c")
    }
    It "returns false when the leaf is missing" {
        $h = @{ a = @{ b = 1 } }
        $ok = Remove-NestedValue -obj $h -path "a.zzz"
        Assert-False $ok
    }
    It "prunes empty parent hashtables walking back up" {
        $h = @{ a = @{ b = @{ c = 1 } } }
        Remove-NestedValue -obj $h -path "a.b.c" | Out-Null
        Assert-False $h.ContainsKey("a")  "a should also be pruned (b became empty, then a)"
    }
    It "stops pruning when a parent still has siblings" {
        $h = @{ a = @{ b = @{ c = 1 }; sibling = "stay" } }
        Remove-NestedValue -obj $h -path "a.b.c" | Out-Null
        Assert-False $h.a.ContainsKey("b") "b should be pruned (became empty)"
        Assert-True  $h.a.ContainsKey("sibling") "sibling must remain"
    }
}

Describe "Convert-ConfigValueString" {
    It "parses bool true/1/yes/on" {
        foreach ($v in @("true", "1", "yes", "on")) {
            $r = Convert-ConfigValueString -valueStr $v -type "bool"
            Assert-Equal $true $r "input was '$v'"
        }
    }
    It "parses bool false/0/no/off" {
        foreach ($v in @("false", "0", "no", "off")) {
            $r = Convert-ConfigValueString -valueStr $v -type "bool"
            Assert-Equal $false $r "input was '$v'"
        }
    }
    It "throws on garbage bool input" {
        Assert-Throws { Convert-ConfigValueString -valueStr "perhaps" -type "bool" } "expected bool"
    }
    It "parses int" {
        Assert-Equal 8192 (Convert-ConfigValueString -valueStr "8192" -type "int")
    }
    It "parses float" {
        Assert-Equal 0.92 (Convert-ConfigValueString -valueStr "0.92" -type "float")
    }
    It "parses array as CSV with trim and empty-drop" {
        $r = Convert-ConfigValueString -valueStr "a, b,, c" -type "array"
        Assert-Equal 3 $r.Count
        Assert-Equal "a" $r[0]
        Assert-Equal "b" $r[1]
        Assert-Equal "c" $r[2]
    }
    It "auto-infers type for null-schema keys (bool wins)" {
        $r = Convert-ConfigValueString -valueStr "true" -type "null"
        Assert-Equal $true $r
    }
    It "auto-infers type for null-schema keys (int wins)" {
        $r = Convert-ConfigValueString -valueStr "123" -type "null"
        Assert-Equal 123 $r
    }
    It "auto-infers type for null-schema keys (float wins)" {
        $r = Convert-ConfigValueString -valueStr "1.5" -type "null"
        Assert-Equal 1.5 $r
    }
    It "auto-infers type for null-schema keys (string fallback)" {
        $r = Convert-ConfigValueString -valueStr "C:\path\here" -type "null"
        Assert-Equal "C:\path\here" $r
    }
    It "rejects setting a whole object" {
        Assert-Throws { Convert-ConfigValueString -valueStr "x" -type "object" } "leaf keys"
    }
}

Describe "Get-RuntimeType" {
    It "classifies primitive types" {
        Assert-Equal "null"   (Get-RuntimeType -v $null)
        Assert-Equal "bool"   (Get-RuntimeType -v $true)
        Assert-Equal "int"    (Get-RuntimeType -v 42)
        Assert-Equal "float"  (Get-RuntimeType -v 3.14)
        Assert-Equal "string" (Get-RuntimeType -v "hi")
        Assert-Equal "array"  (Get-RuntimeType -v @(1, 2))
        Assert-Equal "object" (Get-RuntimeType -v @{ a = 1 })
    }
}

Describe "Format-ConfigValue" {
    It "formats null, bool, primitives" {
        Assert-Equal "(null)" (Format-ConfigValue $null)
        Assert-Equal "true"   (Format-ConfigValue $true)
        Assert-Equal "false"  (Format-ConfigValue $false)
        Assert-Equal "42"     (Format-ConfigValue 42)
    }
    It "formats array of primitives without quoting numbers" {
        $r = Format-ConfigValue @(20, 24, 28)
        Assert-Equal "[20, 24, 28]" $r
    }
    It "formats array of strings with quotes" {
        $r = Format-ConfigValue @("a", "b")
        Assert-Equal '["a", "b"]' $r
    }
    It "compresses nested hashtables to {...}" {
        $r = Format-ConfigValue @(@{ a = 1 }, @{ b = 2 })
        Assert-Equal "[{...}, {...}]" $r
    }
}

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

Describe "Test-IsBetterWinner" {
    # Shorthand for building a candidate.
    function _r { param($eval, $shared) [PSCustomObject]@{ eval_tps = $eval; shared_peak_mib = $shared } }

    It "accepts any candidate when current is null" {
        Assert-True (Test-IsBetterWinner -candidate (_r 30 0) -current $null)
    }
    Describe "default (safety preference)" {
        It "prefers a safe config over a paging one even if slower" {
            $current   = _r 50 1000   # fast, paging
            $candidate = _r 30 0      # slower, safe
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "rejects a paging candidate when current is safe" {
            $current   = _r 30 0
            $candidate = _r 50 1000
            Assert-False (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "picks the higher eval_tps when both are safe" {
            $current   = _r 30 0
            $candidate = _r 40 0
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "picks the higher eval_tps when both are paging" {
            $current   = _r 30 1000
            $candidate = _r 40 1000
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
    }
    Describe "-PreferSpeed (safety ignored)" {
        It "picks the higher eval_tps even when paging" {
            $current   = _r 30 0       # safe, slower
            $candidate = _r 50 1000    # paging, faster
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current -preferSpeed)
        }
        It "rejects a slower candidate even if it's safer" {
            $current   = _r 50 1000    # paging, faster
            $candidate = _r 30 0       # safe, slower
            Assert-False (Test-IsBetterWinner -candidate $candidate -current $current -preferSpeed)
        }
    }
    Describe "shared_delta_confirm_mib threshold" {
        It "treats baseline drift below the default threshold as safe" {
            # Real desktop case: Chrome+Discord baseline ~250 MiB. Picker should
            # NOT call this paging (default threshold = 500).
            $current   = _r 30 250     # background drift, formerly considered paging
            $candidate = _r 40 280     # higher eval, also drift
            # Both safe under threshold=500 -> pick by eval_tps.
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "still treats clear paging (above threshold) as unsafe" {
            $current   = _r 30 100     # safe drift
            $candidate = _r 50 1000    # paging
            Assert-False (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "respects a custom -sharedConfirmMib parameter" {
            $current   = _r 30 100     # safe under 500, BUT unsafe under 50
            $candidate = _r 50 30      # safe under 50 too
            # With strict threshold 50, current is "paging" and candidate is safe -> safety wins.
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current -sharedConfirmMib 50)
        }
    }
}

Describe "Get-ResultDerivedFields" {
    It "computes time_total_sec from prompt + eval timings" {
        # 80 prompt tokens at 100 t/s = 0.8s; 128 eval tokens at 50 t/s = 2.56s; total = 3.36s
        $r = [PSCustomObject]@{
            prompt_n=80; eval_n=128; prompt_tps=100.0; eval_tps=50.0
            vram_peak_mib=2000; extra_args="--ctx-size 16384 --gpu-layers 99"
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal 3.36 $d.time_total_sec
    }
    It "returns null time_total_sec when timings are missing" {
        $r = [PSCustomObject]@{
            prompt_n=0; eval_n=0; prompt_tps=0; eval_tps=0
            vram_peak_mib=2000; extra_args=""
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal $null $d.time_total_sec
    }
    It "computes headroom_mib as vram_total - vram_peak" {
        $r = [PSCustomObject]@{
            prompt_n=10; eval_n=10; prompt_tps=10.0; eval_tps=10.0
            vram_peak_mib=2000; extra_args=""
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal 6192 $d.headroom_mib
    }
    It "clamps headroom_mib at 0 when vram_peak exceeds vram_total" {
        $r = [PSCustomObject]@{
            prompt_n=10; eval_n=10; prompt_tps=10.0; eval_tps=10.0
            vram_peak_mib=9000; extra_args=""
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal 0 $d.headroom_mib
    }
    It "parses ctx_size from extra_args" {
        $r = [PSCustomObject]@{
            prompt_n=10; eval_n=10; prompt_tps=10.0; eval_tps=10.0
            vram_peak_mib=2000; extra_args="--ctx-size 32768 --gpu-layers 99"
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal 32768 $d.ctx_size
    }
    It "returns null ctx_size when --ctx-size is absent" {
        $r = [PSCustomObject]@{
            prompt_n=10; eval_n=10; prompt_tps=10.0; eval_tps=10.0
            vram_peak_mib=2000; extra_args="--gpu-layers 99"
        }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal $null $d.ctx_size
    }
    It "tolerates a result that is missing optional fields" {
        $r = [PSCustomObject]@{ vram_peak_mib=1000 }
        $d = Get-ResultDerivedFields -result $r -vramTotal 8192
        Assert-Equal $null $d.time_total_sec
        Assert-Equal 7192 $d.headroom_mib
        Assert-Equal $null $d.ctx_size
    }
}

Exit-WithResults
