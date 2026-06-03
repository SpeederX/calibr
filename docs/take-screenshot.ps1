# Captures a PNG screenshot of data/report.html using Edge headless.
# Output: docs/report-complete.png (referenced from README.md).
# The captured copy opens with "All sessions" active so the screenshot shows
# the complete benchmark history rather than only the latest run.
$root = Split-Path $PSScriptRoot -Parent
$report = Join-Path $root "data\report.html"
$out = Join-Path $PSScriptRoot "report-complete.png"
$temp = Join-Path $env:TEMP "calibr-report-all-sessions.html"

if (-not (Test-Path $report)) {
    throw "report.html not found at $report. Run '.\calibr.ps1 report' first."
}

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edge)) {
    throw "Edge not found. Install msedge or modify this script for Chrome/Chromium."
}

$html = Get-Content -Path $report -Raw -Encoding UTF8
$html = $html.Replace("scope:   'latest',", "scope:   'all',")
Set-Content -Path $temp -Value $html -Encoding UTF8

# file:// URI for absolute path
$uri = "file:///" + ($temp -replace '\\','/')

# Headless screenshot. window-size makes the viewport tall enough to capture all top sections.
# NOTE: classic --headless works on PS 5.1; --headless=new sometimes silently no-ops.
Write-Host "Capturing $report -> $out"
$profile = Join-Path $env:TEMP "calibr-edge-profile"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$cmd = "& `"$edge`" --headless --disable-gpu --hide-scrollbars --user-data-dir=`"$profile`" --window-size=1600,3000 --screenshot=`"$out`" `"$uri`""
Invoke-Expression $cmd
if (Test-Path $out) {
    $sz = [math]::Round((Get-Item $out).Length / 1KB, 1)
    Write-Host "Done: $out ($sz KB)" -ForegroundColor Green
} else {
    Write-Host "Edge exited but no screenshot was created." -ForegroundColor Red
}
