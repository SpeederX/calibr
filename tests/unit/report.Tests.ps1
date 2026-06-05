# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

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


