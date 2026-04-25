# Captures a PNG screenshot of data/report.html using Edge headless.
# Output: docs/screenshot.png (referenced from README.md hero).
$root = Split-Path $PSScriptRoot -Parent
$report = Join-Path $root "data\report.html"
$out = Join-Path $PSScriptRoot "screenshot.png"

if (-not (Test-Path $report)) {
    throw "report.html not found at $report. Run '.\llm-lab.ps1 report' first."
}

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edge)) {
    throw "Edge not found. Install msedge or modify this script for Chrome/Chromium."
}

# file:// URI for absolute path
$uri = "file:///" + ($report -replace '\\','/')

# Headless screenshot. window-size makes the viewport tall enough to capture all sections.
# NOTE: classic --headless works on PS 5.1; --headless=new sometimes silently no-ops.
Write-Host "Capturing $report -> $out"
$cmd = "& `"$edge`" --headless --disable-gpu --hide-scrollbars --window-size=1500,2600 --screenshot=`"$out`" `"$uri`""
Invoke-Expression $cmd
if (Test-Path $out) {
    $sz = [math]::Round((Get-Item $out).Length / 1KB, 1)
    Write-Host "Done: $out ($sz KB)" -ForegroundColor Green
} else {
    Write-Host "Edge exited but no screenshot was created." -ForegroundColor Red
}
