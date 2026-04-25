# Test runner. Discovers all *.Tests.ps1 in this directory, runs each in a
# fresh subprocess so global state (functions, $script:*) doesn't leak between
# files. Aggregates pass/fail and exits non-zero if any test failed.
[CmdletBinding()]
param([string]$Filter = "")

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$files = Get-ChildItem -Path $here -Filter "*.Tests.ps1" | Sort-Object Name
if ($Filter) { $files = $files | Where-Object { $_.Name -like "*$Filter*" } }

$totalFail = 0
$start = Get-Date

foreach ($f in $files) {
    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor DarkGray
    Write-Host (" RUN: {0}" -f $f.Name) -ForegroundColor White
    Write-Host "======================================================================" -ForegroundColor DarkGray
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f.FullName
    if ($LASTEXITCODE -ne 0) { $totalFail++ }
}

$dur = ((Get-Date) - $start).TotalSeconds
Write-Host ""
Write-Host "======================================================================" -ForegroundColor DarkGray
if ($totalFail -eq 0) {
    Write-Host (" ALL FILES PASSED  ({0} files, {1:N1}s)" -f $files.Count, $dur) -ForegroundColor Green
    exit 0
} else {
    Write-Host (" {0}/{1} TEST FILES FAILED  ({2:N1}s)" -f $totalFail, $files.Count, $dur) -ForegroundColor Red
    exit 1
}
