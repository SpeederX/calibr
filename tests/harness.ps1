# Tiny Describe/It test harness. Zero dependencies (works on any PS 5.1+).
# We avoid Pester so CI doesn't have to install anything.
#
# Usage in a test file:
#     . "$PSScriptRoot\harness.ps1"
#     Describe "Group label" {
#         It "does the thing" {
#             Assert-Equal 4 (2 + 2)
#         }
#     }
#     Exit-WithResults

$script:TH_RESULTS = @{ pass = 0; fail = 0; failures = @() }
$script:TH_GROUP = ""

function Describe {
    param([string]$Name, [scriptblock]$Body)
    $script:TH_GROUP = $Name
    Write-Host ""
    Write-Host "## $Name" -ForegroundColor Cyan
    & $Body
}

function It {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:TH_RESULTS.pass++
        Write-Host "  [ok]   $Name" -ForegroundColor Green
    } catch {
        $script:TH_RESULTS.fail++
        $script:TH_RESULTS.failures += [PSCustomObject]@{
            Group = $script:TH_GROUP
            Test  = $Name
            Error = $_.Exception.Message
        }
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        Write-Host "         $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Hint = "")
    if ($Expected -ne $Actual) {
        $h = if ($Hint) { " ($Hint)" } else { "" }
        throw "expected '$Expected' but got '$Actual'$h"
    }
}

function Assert-True {
    param($Condition, [string]$Hint = "")
    if (-not $Condition) {
        $h = if ($Hint) { ": $Hint" } else { "" }
        throw "expected true but got '$Condition'$h"
    }
}

function Assert-False {
    param($Condition, [string]$Hint = "")
    if ($Condition) {
        $h = if ($Hint) { ": $Hint" } else { "" }
        throw "expected false but got '$Condition'$h"
    }
}

function Assert-Throws {
    param([scriptblock]$Body, [string]$MatchPattern = "")
    $threw = $false
    $msg = ""
    try { & $Body } catch { $threw = $true; $msg = $_.Exception.Message }
    if (-not $threw) { throw "expected exception, none thrown" }
    if ($MatchPattern -and ($msg -notmatch $MatchPattern)) {
        throw "exception '$msg' did not match pattern '$MatchPattern'"
    }
}

function Exit-WithResults {
    Write-Host ""
    $r = $script:TH_RESULTS
    if ($r.fail -eq 0) {
        Write-Host ("== {0} pass / {1} fail ==" -f $r.pass, $r.fail) -ForegroundColor Green
        exit 0
    } else {
        Write-Host ("== {0} pass / {1} fail ==" -f $r.pass, $r.fail) -ForegroundColor Red
        Write-Host "Failures:" -ForegroundColor Red
        foreach ($f in $r.failures) {
            Write-Host ("  - [{0}] {1}: {2}" -f $f.Group, $f.Test, $f.Error) -ForegroundColor Red
        }
        exit 1
    }
}
