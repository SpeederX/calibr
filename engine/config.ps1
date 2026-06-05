# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# CONFIG LOADING (default <- local override, deep merge)
# ============================================================================
function Merge-Hashtables {
    param($base, $over)
    if ($null -eq $over) { return $base }
    foreach ($k in $over.Keys) {
        if ($base.ContainsKey($k) -and $base[$k] -is [hashtable] -and $over[$k] -is [hashtable]) {
            $base[$k] = Merge-Hashtables $base[$k] $over[$k]
        } else {
            $base[$k] = $over[$k]
        }
    }
    return $base
}

function ConvertTo-Hashtable {
    param($obj)
    if ($null -eq $obj) { return $null }
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $obj.PSObject.Properties) {
            $h[$p.Name] = ConvertTo-Hashtable $p.Value
        }
        return $h
    }
    if ($obj -is [array]) {
        # The leading comma prevents PowerShell from unwrapping single-element
        # arrays, which would turn ["path"] into the string "path" and break
        # any subsequent [0] index.
        $arr = @($obj | ForEach-Object { ConvertTo-Hashtable $_ })
        return ,$arr
    }
    return $obj
}

function Get-Config {
    if (-not (Test-Path $CALIBR_DEFAULT_CFG)) { throw "Missing config.default.json at $CALIBR_DEFAULT_CFG" }
    $defRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $default = ConvertTo-Hashtable -obj $defRaw
    if (Test-Path $CALIBR_LOCAL_CFG) {
        $locRaw = Get-Content $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
        $local = ConvertTo-Hashtable -obj $locRaw
        $default = Merge-Hashtables $default $local
    }
    # Strip _comment_* keys for cleanliness
    $result = @{}
    foreach ($k in $default.Keys) {
        if ($k -notmatch '^_comment') { $result[$k] = $default[$k] }
    }

    # Apply CLI overrides (highest priority, never persisted to disk)
    if ($script:ScanPath -and $script:ScanPath.Count -gt 0) {
        $result.scan_paths = @($script:ScanPath)
    }
    if ($script:LlamaServer) {
        $result.llama_server_exe = $script:LlamaServer
    }
    if ($script:ExcludePattern -and $script:ExcludePattern.Count -gt 0) {
        $existing = if ($result.exclude_patterns) { @($result.exclude_patterns) } else { @() }
        $result.exclude_patterns = @($existing + $script:ExcludePattern)
    }

    # Auto-detect hardware in-memory if the user hasn't supplied it via config.json.
    # This makes the tool usable end-to-end with just CLI flags, no init / config.json required.
    if ($result.hardware -and -not $result.hardware.vram_total_mib -and $result.hardware.auto_detect) {
        $detected = Get-DetectedHardware
        if ($detected.vram_total_mib) {
            $result.hardware.vram_total_mib = $detected.vram_total_mib
            $pct = if ($result.hardware.vram_safety_budget_pct) { $result.hardware.vram_safety_budget_pct } else { 0.95 }
            $result.hardware.vram_safety_budget_mib = [int]($detected.vram_total_mib * $pct)
            $result.hardware.gpu_name           = $detected.gpu_name
            $result.hardware.gpu_compute_cap    = $detected.gpu_compute_cap
            $result.hardware.cpu_cores_physical = $detected.cpu_cores_physical
            $result.hardware.cpu_threads_logical= $detected.cpu_threads_logical
        }
    }

    return $result
}


# ============================================================================
# SUBCOMMAND: config (list / get / set / unset)
# ============================================================================
function Get-NestedValue {
    # Walk a hashtable along a dot-path. Returns @{ found=$bool; value=$any }.
    param($obj, [string]$path)
    $parts = $path -split '\.'
    $cur = $obj
    foreach ($p in $parts) {
        if ($cur -is [hashtable] -and $cur.ContainsKey($p)) { $cur = $cur[$p] }
        else { return @{ found=$false; value=$null } }
    }
    return @{ found=$true; value=$cur }
}

function Set-NestedValue {
    # Set a value at a dot-path, creating intermediate hashtables as needed.
    param($obj, [string]$path, $value)
    $parts = $path -split '\.'
    $cur = $obj
    for ($i=0; $i -lt $parts.Count - 1; $i++) {
        if (-not ($cur -is [hashtable])) { throw "cannot descend into non-object at '$($parts[0..$i] -join '.')'" }
        if (-not $cur.ContainsKey($parts[$i])) { $cur[$parts[$i]] = @{} }
        $cur = $cur[$parts[$i]]
    }
    if (-not ($cur -is [hashtable])) { throw "cannot set leaf on non-object" }
    $cur[$parts[-1]] = $value
}

function Remove-NestedValue {
    # Remove a key at a dot-path. Returns $true if removed, $false if not present.
    # After removing the leaf, walks back up the chain and prunes any parent
    # hashtable that became empty as a result, stopping as soon as we find a
    # parent that still has siblings. Avoids leaving carcasses like `bench:{}`
    # in config.json after an unset.
    param($obj, [string]$path)
    $parts = $path -split '\.'

    $stack = @()
    $cur = $obj
    for ($i=0; $i -lt $parts.Count - 1; $i++) {
        if (-not ($cur -is [hashtable]) -or -not $cur.ContainsKey($parts[$i])) { return $false }
        $stack += ,@($cur, $parts[$i])
        $cur = $cur[$parts[$i]]
    }
    if (-not ($cur -is [hashtable]) -or -not $cur.ContainsKey($parts[-1])) { return $false }
    $cur.Remove($parts[-1])

    for ($i = $stack.Count - 1; $i -ge 0; $i--) {
        $parent = $stack[$i][0]
        $key    = $stack[$i][1]
        if ($parent[$key] -is [hashtable] -and $parent[$key].Count -eq 0) {
            $parent.Remove($key)
        } else {
            break
        }
    }
    return $true
}

function Get-FlatConfig {
    # Emit (Key, Value) rows with dot-notation paths, skipping _comment_* keys.
    # Stream-style: each PSCustomObject flows to the pipeline directly so callers
    # can either pipe them through ForEach-Object or collect with @(...).
    param($obj, [string]$prefix = "")
    foreach ($k in ($obj.Keys | Sort-Object)) {
        if ($k -match '^_comment') { continue }
        $key = if ($prefix) { "$prefix.$k" } else { $k }
        $v = $obj[$k]
        if ($v -is [hashtable]) {
            Get-FlatConfig -obj $v -prefix $key
        } else {
            [PSCustomObject]@{ Key=$key; Value=$v }
        }
    }
}

function Get-RuntimeType {
    # Type of the actual value (used for display in list/get).
    param($v)
    if ($null -eq $v)                                          { return "null"   }
    if ($v -is [bool])                                         { return "bool"   }
    if ($v -is [int] -or $v -is [long])                        { return "int"    }
    if ($v -is [double] -or $v -is [single] -or $v -is [decimal]) { return "float" }
    if ($v -is [array])                                        { return "array"  }
    if ($v -is [hashtable])                                    { return "object" }
    return "string"
}

function Get-ConfigValueType {
    # Type from the default schema (used by set to know how to parse the input).
    # Returns "null" when the schema has a null placeholder; "unknown" if the key
    # doesn't exist in the schema at all.
    param($defaultCfg, [string]$path)
    $r = Get-NestedValue -obj $defaultCfg -path $path
    if (-not $r.found) { return "unknown" }
    return Get-RuntimeType -v $r.value
}

function Convert-ConfigValueString {
    # Parse a CLI string into the right type for writing into config.json.
    # When the schema type is "null" (placeholder in default), guess from the value shape.
    param([string]$valueStr, [string]$type)
    switch ($type) {
        "bool" {
            if ($valueStr -match '^(true|1|yes|on)$')  { return $true }
            if ($valueStr -match '^(false|0|no|off)$') { return $false }
            throw "expected bool (true/false/1/0/yes/no/on/off); got '$valueStr'"
        }
        "int"   { return [int]$valueStr }
        "float" { return [double]$valueStr }
        "array" { return @($valueStr -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
        "object" { throw "cannot set an entire object; set its leaf keys individually" }
        "null" {
            if ($valueStr -match '^(true|false)$')   { return [bool]::Parse($valueStr) }
            if ($valueStr -match '^-?\d+$')          { return [int]$valueStr }
            if ($valueStr -match '^-?\d+\.\d+$')     { return [double]$valueStr }
            return $valueStr
        }
        default { return $valueStr }
    }
}

function Format-ConfigValue {
    param($v)
    if ($null -eq $v)   { return "(null)" }
    if ($v -is [bool])  { return $v.ToString().ToLower() }
    if ($v -is [array]) {
        if ($v.Count -eq 0) { return "[]" }
        $items = @($v | ForEach-Object {
            if ($_ -is [hashtable]) { "{...}" }
            elseif ($_ -is [string]) { '"' + $_ + '"' }
            elseif ($_ -is [bool]) { $_.ToString().ToLower() }
            else { [string]$_ }
        })
        return "[" + ($items -join ', ') + "]"
    }
    if ($v -is [hashtable]) { return "{...}" }
    return [string]$v
}

function Show-ConfigUsage {
    Write-Host "Usage: calibr config <action> [<key>] [<value>]"
    Write-Host ""
    Write-Host "Actions:" -ForegroundColor White
    Write-Host "  list                 Print all keys with type + source ([default] / [local])"
    Write-Host "  get <key>            Print one value (or sub-keys for an object)"
    Write-Host "  set <key> <value>    Write a leaf value to config.json (override default)"
    Write-Host "  unset <key>          Remove the local override (default applies again)"
    Write-Host "  detect [<key>]       Auto-detect a value (interactive picker for ambiguous matches)"
    Write-Host "                       Supported keys: llama_server_exe, hardware, all (default: all)"
    Write-Host ""
    Write-Host "Run 'calibr help config' for examples and details."
}

function Invoke-ConfigDetect {
    # Re-runs the same detection logic as `init` but writes only the requested key
    # to the local config. Returns $true on a successful write, $false otherwise.
    param([string]$keyName, $localCfg, $defaultCfg)

    switch ($keyName) {
        "llama_server_exe" {
            Write-Host "Searching for llama-server$script:ExeExt..." -ForegroundColor Cyan
            $exes = @(Find-LlamaServerExe)
            if ($exes.Count -eq 0) {
                Write-Host "  No candidates found. Set manually with: calibr config set llama_server_exe `"<path>`"" -ForegroundColor Yellow
                return $false
            }
            $picked = $null
            if ($exes.Count -eq 1) {
                $picked = $exes[0]
                Write-Host "  Found single candidate: $picked" -ForegroundColor Green
            } else {
                Write-Host "  Multiple candidates:" -ForegroundColor Yellow
                for ($i=0; $i -lt $exes.Count; $i++) { Write-Host "    [$i] $($exes[$i])" }
                if ($NonInteractive) {
                    $picked = $exes[0]
                    Write-Host "  Picked [0] (non-interactive). Re-run with -NonInteractive:`$false to choose."
                } else {
                    $idx = Read-Host "  Pick index [0]"
                    if (-not $idx) { $idx = 0 }
                    $picked = $exes[[int]$idx]
                }
            }
            $localCfg["llama_server_exe"] = $picked
            Write-Host "  Set llama_server_exe = $picked" -ForegroundColor Green
            return $true
        }
        "hardware" {
            Write-Host "Detecting hardware..." -ForegroundColor Cyan
            $hw = Get-DetectedHardware
            if ($hw.gpu_name) {
                Write-Host "  GPU: $($hw.gpu_name), $($hw.vram_total_mib) MiB VRAM, compute $($hw.gpu_compute_cap)" -ForegroundColor Green
            } else {
                Write-Host "  nvidia-smi not available or no NVIDIA GPU detected. Set hardware.* keys manually." -ForegroundColor Yellow
                return $false
            }
            if ($hw.cpu_cores_physical) {
                Write-Host "  CPU: $($hw.cpu_cores_physical)C/$($hw.cpu_threads_logical)T" -ForegroundColor Green
            }

            $pct = if ($defaultCfg.hardware.vram_safety_budget_pct) { $defaultCfg.hardware.vram_safety_budget_pct } else { 0.95 }
            if (-not ($localCfg["hardware"] -is [hashtable])) { $localCfg["hardware"] = @{} }
            $h = $localCfg["hardware"]
            $h["auto_detect"] = $false
            if ($hw.vram_total_mib) {
                $h["vram_total_mib"]         = $hw.vram_total_mib
                $h["vram_safety_budget_mib"] = [int]($hw.vram_total_mib * $pct)
            }
            if ($hw.gpu_name)            { $h["gpu_name"]            = $hw.gpu_name }
            if ($hw.gpu_compute_cap)     { $h["gpu_compute_cap"]     = $hw.gpu_compute_cap }
            if ($hw.cpu_cores_physical)  { $h["cpu_cores_physical"]  = $hw.cpu_cores_physical }
            if ($hw.cpu_threads_logical) { $h["cpu_threads_logical"] = $hw.cpu_threads_logical }
            return $true
        }
        default {
            Write-Host "Unknown detect key '$keyName'. Supported: llama_server_exe, hardware, all" -ForegroundColor Yellow
            return $false
        }
    }
}

function Invoke-Config {
    if (-not $Action) { Show-ConfigUsage; return }
    $act = $Action.ToLower()

    $defRaw = Get-Content $CALIBR_DEFAULT_CFG -Raw | ConvertFrom-Json
    $defaultCfg = ConvertTo-Hashtable -obj $defRaw
    $effective  = Get-Config

    $localCfg = @{}
    if (Test-Path $CALIBR_LOCAL_CFG) {
        $locRaw = Get-Content $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
        $localCfg = ConvertTo-Hashtable -obj $locRaw
    }

    switch ($act) {
        "list" {
            $rows = @(Get-FlatConfig -obj $effective)
            $maxKey = ($rows | ForEach-Object { $_.Key.Length } | Measure-Object -Maximum).Maximum
            $localLabel = if (Test-Path $CALIBR_LOCAL_CFG) { Split-Path $CALIBR_LOCAL_CFG -Leaf } else { "(no local override)" }
            Write-Host ("=== config (effective: default <- {0}) ===" -f $localLabel) -ForegroundColor Cyan
            foreach ($r in $rows) {
                $type   = Get-RuntimeType -v $r.Value
                $localR = Get-NestedValue -obj $localCfg -path $r.Key
                $marker = if ($localR.found) { "[local]" } else { "[default]" }
                $color  = if ($localR.found) { 'Green' } else { 'Gray' }
                $line   = "  {0,-$maxKey}  {1,-8}  {2,-9}  {3}" -f $r.Key, "($type)", $marker, (Format-ConfigValue $r.Value)
                Write-Host $line -ForegroundColor $color
            }
        }
        "get" {
            if (-not $Key) { throw "config get requires a key. Try 'calibr config list'." }
            $r = Get-NestedValue -obj $effective -path $Key
            if (-not $r.found) { Write-Host "key '$Key' not found." -ForegroundColor Yellow; return }
            $type   = Get-RuntimeType -v $r.value
            $localR = Get-NestedValue -obj $localCfg -path $Key
            $source = if ($localR.found) { "[local]" } else { "[default]" }
            if ($r.value -is [hashtable]) {
                Write-Host "$Key (object) $source" -ForegroundColor Cyan
                Get-FlatConfig -obj $r.value -prefix $Key | ForEach-Object {
                    $t = Get-RuntimeType -v $_.Value
                    Write-Host ("  {0}  ({1})  = {2}" -f $_.Key, $t, (Format-ConfigValue $_.Value))
                }
            } else {
                Write-Host ("{0} = {1}  ({2}) {3}" -f $Key, (Format-ConfigValue $r.value), $type, $source) -ForegroundColor Cyan
            }
        }
        "set" {
            if (-not $Key)        { throw "config set requires a key. e.g. config set hardware.vram_total_mib 8192" }
            if ($null -eq $Value) { throw "config set requires a value." }
            $type = Get-ConfigValueType -defaultCfg $defaultCfg -path $Key
            if ($type -eq "unknown") { throw "key '$Key' is not in config.default.json. Edit the file directly to add new keys." }
            if ($type -eq "object")  { throw "'$Key' is an object; set its leaf keys individually." }
            $converted = Convert-ConfigValueString -valueStr $Value -type $type
            Set-NestedValue -obj $localCfg -path $Key -value $converted
            $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
            Write-Host ("set {0} = {1}  ({2}) -> {3}" -f $Key, (Format-ConfigValue $converted), $type, (Split-Path $CALIBR_LOCAL_CFG -Leaf)) -ForegroundColor Green
        }
        "unset" {
            if (-not $Key) { throw "config unset requires a key." }
            if (-not (Test-Path $CALIBR_LOCAL_CFG)) {
                Write-Host "no local config.json present; nothing to unset." -ForegroundColor Yellow
                return
            }
            $removed = Remove-NestedValue -obj $localCfg -path $Key
            if ($removed) {
                $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
                Write-Host "unset $Key  (default value applies on next run)" -ForegroundColor Green
            } else {
                Write-Host "key '$Key' was not in $(Split-Path $CALIBR_LOCAL_CFG -Leaf); nothing to do." -ForegroundColor Yellow
            }
        }
        "detect" {
            $target = if ($Key) { $Key.ToLower() } else { "all" }
            $any = $false
            if ($target -eq "all") {
                $r1 = Invoke-ConfigDetect -keyName "llama_server_exe" -localCfg $localCfg -defaultCfg $defaultCfg
                Write-Host ""
                $r2 = Invoke-ConfigDetect -keyName "hardware" -localCfg $localCfg -defaultCfg $defaultCfg
                $any = ($r1 -or $r2)
            } else {
                $any = Invoke-ConfigDetect -keyName $target -localCfg $localCfg -defaultCfg $defaultCfg
            }
            if ($any) {
                $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
                Write-Host ""
                Write-Host "Saved -> $(Split-Path $CALIBR_LOCAL_CFG -Leaf)" -ForegroundColor Green
            } else {
                Write-Host ""
                Write-Host "Nothing detected; config.json unchanged." -ForegroundColor DarkGray
            }
        }
        default {
            Write-Host "Unknown config action '$Action'." -ForegroundColor Yellow
            Write-Host ""
            Show-ConfigUsage
        }
    }
}


