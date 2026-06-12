# Action-level trace logging shared by the CLI and PowerShell engine.
# Keep this best-effort: diagnostics must never break the user action.

function Get-TraceParent {
    try {
        if ($env:CALIBR_TRACE_PARENT) {
            return ($env:CALIBR_TRACE_PARENT | ConvertFrom-Json)
        }
    } catch { }
    return $null
}

function Write-TraceEvent {
    param(
        [string]$Source = "engine",
        [string]$Flow = "",
        [string]$Action = "",
        [string]$Status = "",
        [string]$Message = "",
        $Details = $null
    )
    try {
        if (-not $script:CALIBR_LOGS_DIR) { return }
        if (-not (Test-Path -LiteralPath $script:CALIBR_LOGS_DIR)) {
            New-Item -ItemType Directory -Path $script:CALIBR_LOGS_DIR -Force | Out-Null
        }
        $parent = Get-TraceParent
        $eventFlow = if ($Flow) { $Flow } elseif ($parent -and $parent.flow) { [string]$parent.flow } else { "engine" }
        $eventAction = if ($Action) { $Action } elseif ($parent -and $parent.action) { [string]$parent.action } else { "unknown" }
        $eventMessage = if ($Message) { $Message } else { "$eventFlow > $eventAction $Status" }
        $payload = [ordered]@{
            ts      = (Get-Date).ToUniversalTime().ToString("o")
            source  = $Source
            flow    = $eventFlow
            action  = $eventAction
            status  = $Status
            message = $eventMessage
            details = if ($Details) { $Details } else { @{} }
        }
        $path = Join-Path $script:CALIBR_LOGS_DIR "action-trace.jsonl"
        Add-Content -LiteralPath $path -Value ($payload | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
    } catch { }
}

