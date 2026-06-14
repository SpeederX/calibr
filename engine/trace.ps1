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

function Protect-TraceText {
    param([string]$Text)
    if (-not $Text) { return $Text }
    $out = $Text
    $homePath = [Environment]::GetFolderPath('UserProfile')
    $homeLabel = if ($script:IsWin) { '%USERPROFILE%' } else { '$HOME' }
    $pairs = @(
        @{ Path = $script:CALIBR_DATA_DIR; Label = '<CALIBR_DATA_DIR>' }
        @{ Path = $script:CALIBR_ROOT; Label = '<CALIBR_ROOT>' }
        @{ Path = $homePath; Label = $homeLabel }
        @{ Path = $env:LOCALAPPDATA; Label = '%LOCALAPPDATA%' }
        @{ Path = $env:APPDATA; Label = '%APPDATA%' }
    ) | Where-Object { $_.Path } | Sort-Object { ([string]$_.Path).Length } -Descending
    foreach ($p in $pairs) {
        $path = [string]$p.Path
        $label = [string]$p.Label
        $out = $out.Replace($path, $label)
        if ($script:IsWin) { $out = $out.Replace($path.Replace('\','/'), $label) }
    }
    return $out
}

function Protect-TraceValue {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return (Protect-TraceText $Value) }
    if ($Value -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($key in $Value.Keys) { $out[$key] = Protect-TraceValue $Value[$key] }
        return $out
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $items = @()
        foreach ($item in $Value) { $items += (Protect-TraceValue $item) }
        return $items
    }
    if ($Value -is [pscustomobject]) {
        $out = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) { $out[$prop.Name] = Protect-TraceValue $prop.Value }
        return $out
    }
    return $Value
}

function Format-TraceDetails {
    param($Details)
    if (-not $Details) { return "" }
    $pairs = @()
    if ($Details -is [System.Collections.IDictionary]) {
        foreach ($key in $Details.Keys) {
            $value = $Details[$key]
            if ($null -ne $value -and "$value" -ne "") { $pairs += ("{0}={1}" -f $key, $value) }
        }
    } elseif ($Details -is [pscustomobject]) {
        foreach ($prop in $Details.PSObject.Properties) {
            if ($null -ne $prop.Value -and "$($prop.Value)" -ne "") { $pairs += ("{0}={1}" -f $prop.Name, $prop.Value) }
        }
    }
    return ($pairs -join ", ")
}

function Format-TraceColumn {
    param([string]$Text, [int]$Width)
    $s = if ($null -eq $Text) { "" } else { [string]$Text }
    if ($s.Length -gt $Width) { return $s.Substring(0, $Width) }
    return $s.PadRight($Width)
}

function Write-HumanTraceEvent {
    param($Payload)
    try {
        $path = Join-Path $script:CALIBR_LOGS_DIR "action-trace.log"
        $time = ([datetime]$Payload.ts).ToString("HH:mm:ss")
        $details = Format-TraceDetails $Payload.details
        if (-not $details) { $details = $Payload.message }
        $row = "{0,-10} | {1,-8} | {2,-22} | {3,-30} | {4,-10} | {5}" -f `
            $time,
            (Format-TraceColumn $Payload.source 8),
            (Format-TraceColumn $Payload.flow 22),
            (Format-TraceColumn $Payload.action 30),
            (Format-TraceColumn $Payload.status 10),
            $details
        Add-Content -LiteralPath $path -Value $row -Encoding UTF8
    } catch { }
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
        $rawMessage = if ($Message) { $Message } else { "$eventFlow > $eventAction $Status" }
        $eventMessage = Protect-TraceText $rawMessage
        $safeDetails = if ($Details) { Protect-TraceValue $Details } else { @{} }
        $sessionId = if ($env:CALIBR_TRACE_SESSION_ID) { $env:CALIBR_TRACE_SESSION_ID } else { "direct" }
        $payload = [ordered]@{
            ts      = (Get-Date).ToUniversalTime().ToString("o")
            source  = $Source
            sessionId = $sessionId
            flow    = $eventFlow
            action  = $eventAction
            status  = $Status
            message = $eventMessage
            details = $safeDetails
        }
        $path = Join-Path $script:CALIBR_LOGS_DIR "action-trace.jsonl"
        Add-Content -LiteralPath $path -Value ($payload | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
        Write-HumanTraceEvent $payload
    } catch { }
}

