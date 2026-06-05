# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Get-ResetTargets" {
    # Use a fresh per-test temp dir so we can create real files / dirs for
    # the existence checks without polluting the repo data/ folder.
    function _newTempRoot {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-reset-test-{0}" -f ([guid]::NewGuid()))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        return $tmp
    }
    function _pathsUnder($root) {
        $resultsDir = Join-Path $root 'results'
        $logsDir    = Join-Path $root 'logs'
        $batsDir    = Join-Path $root 'bats'
        New-Item -ItemType Directory -Path $resultsDir, $logsDir, $batsDir -Force | Out-Null
        return @{
            ResultsDir      = $resultsDir
            CatalogFile     = Join-Path $root 'catalog.json'
            PlanFile        = Join-Path $root 'plan.json'
            ReportFile      = Join-Path $root 'report.html'
            LogsDir         = $logsDir
            BatsDir         = $batsDir
            DownloadsFile   = Join-Path $root 'downloads.json'
            LocalConfigFile = Join-Path $root 'config.json'
        }
    }

    It "returns empty when no toggle is set" {
        $root = _newTempRoot
        $p = _pathsUnder $root
        $r = Get-ResetTargets -Toggles @{} -Paths $p -ManagedFiles @()
        Assert-Equal 0 $r.Count
        Remove-Item -Recurse -Force $root
    }
    It "returns only the buckets whose toggle is true AND whose path exists" {
        $root = _newTempRoot
        $p = _pathsUnder $root
        Set-Content -LiteralPath $p.CatalogFile -Value '[]'
        Set-Content -LiteralPath $p.ReportFile -Value '<html></html>'
        $r = Get-ResetTargets -Toggles @{ Catalog = $true; Report = $true; Plan = $true } -Paths $p -ManagedFiles @()
        # Catalog + Report exist, Plan toggle is on but file is missing.
        Assert-Equal 2 $r.Count
        Assert-True (@($r | ForEach-Object { $_.kind }) -contains 'catalog')
        Assert-True (@($r | ForEach-Object { $_.kind }) -contains 'report')
        Remove-Item -Recurse -Force $root
    }
    It "expands -All into every bucket" {
        $root = _newTempRoot
        $p = _pathsUnder $root
        Set-Content -LiteralPath $p.CatalogFile -Value '[]'
        Set-Content -LiteralPath $p.PlanFile -Value '[]'
        Set-Content -LiteralPath $p.ReportFile -Value '<html></html>'
        Set-Content -LiteralPath $p.DownloadsFile -Value '[]'
        Set-Content -LiteralPath $p.LocalConfigFile -Value '{}'
        $r = Get-ResetTargets -Toggles @{ All = $true } -Paths $p -ManagedFiles @()
        # 5 single-files (catalog, plan, report, downloads, localconfig)
        # PLUS 3 directories that exist (results, logs, bats) = 8 entries.
        Assert-Equal 8 $r.Count
        Remove-Item -Recurse -Force $root
    }
    It "lists each managed file individually when -DownloadedModels is on" {
        $root = _newTempRoot
        $p = _pathsUnder $root
        $f1 = Join-Path $root 'a.gguf'; Set-Content -LiteralPath $f1 -Value 'x'
        $f2 = Join-Path $root 'b.gguf'; Set-Content -LiteralPath $f2 -Value 'y'
        # Plus a 'managed' path that doesn't exist on disk - must be skipped.
        $r = Get-ResetTargets -Toggles @{ DownloadedModels = $true } -Paths $p -ManagedFiles @($f1, $f2, 'C:\nope\missing.gguf')
        Assert-Equal 2 $r.Count
        Remove-Item -Recurse -Force $root
    }
    It "never includes user-owned .gguf files (they are not in ManagedFiles)" {
        # Regression: the contract is 'DownloadedModels' lists ONLY files
        # we know calibr fetched. A user.gguf placed in scan_paths must
        # not be returned even when -DownloadedModels is on AND -All is on.
        $root = _newTempRoot
        $p = _pathsUnder $root
        $userFile = Join-Path $root 'i-own-this.gguf'; Set-Content -LiteralPath $userFile -Value 'mine'
        $r = Get-ResetTargets -Toggles @{ All = $true; DownloadedModels = $true } -Paths $p -ManagedFiles @()
        $allPaths = @($r | ForEach-Object { $_.path })
        Assert-False ($allPaths -contains $userFile)  "user-owned .gguf must not appear in reset targets"
        Remove-Item -Recurse -Force $root
    }
}


