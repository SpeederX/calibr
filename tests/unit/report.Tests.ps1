# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Test-IsBetterWinner" {
    # Shorthand for building a candidate.
    function _r {
        param($eval, $shared, $ctx = 0, $vram = 1000, $kv = $null)
        $args = if ($ctx -gt 0) { "--ctx-size $ctx" } else { "" }
        if ($kv) { $args = "$args --cache-type-k $kv --cache-type-v $kv".Trim() }
        [PSCustomObject]@{
            eval_tps = $eval
            shared_peak_mib = $shared
            vram_peak_mib = $vram
            extra_args = $args
        }
    }

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
        It "uses the tie-band to prefer larger context for near-equal safe configs" {
            $current   = _r 100 0 16384
            $candidate = _r 97 0 65536
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "uses the tie-band to prefer better KV cache before larger context" {
            $current   = _r 65.8 252 163840 6595 "q4_0"
            $candidate = _r 66.0 188 98304 6471 "q8_0"
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "does not let the tie-band override a clearly faster safe config" {
            $current   = _r 100 0 16384
            $candidate = _r 90 0 65536
            Assert-False (Test-IsBetterWinner -candidate $candidate -current $current)
        }
        It "breaks near-equal same-context ties by lower shared memory, then lower VRAM" {
            $current   = _r 100 20 32768 2400
            $candidate = _r 98 10 32768 2600
            Assert-True (Test-IsBetterWinner -candidate $candidate -current $current)

            $current2   = _r 100 10 32768 2400
            $candidate2 = _r 98 10 32768 2200
            Assert-True (Test-IsBetterWinner -candidate $candidate2 -current $current2)
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

    Describe "shared winner-policy fixture parity" {
        $casesPath = Join-Path $PSScriptRoot "..\fixtures\winner-policy-cases.json"
        $cases = Get-Content -LiteralPath $casesPath -Raw | ConvertFrom-Json
        foreach ($case in $cases) {
            It $case.name {
                $winner = $null
                foreach ($candidate in $case.candidates) {
                    $args = @{
                        candidate        = $candidate
                        current          = $winner
                        sharedConfirmMib = 500
                    }
                    if ($case.profile -eq "speed") { $args.preferSpeed = $true }
                    if (Test-IsBetterWinner @args) { $winner = $candidate }
                }
                Assert-Equal $case.expected $winner.id
            }
        }
    }
}

Exit-WithResults


