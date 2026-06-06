# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

# ============================================================================
# PLATFORM
# ============================================================================
# $IsWindows / $IsLinux / $IsMacOS are automatic variables ONLY in PowerShell
# Core (6+). Windows PowerShell 5.1 - what Windows users get via calibr.cmd -
# leaves them undefined, so we read them defensively (Get-Variable tolerates
# their absence) and treat "neither Linux nor macOS" as Windows.
$script:IsLin = [bool](Get-Variable -Name IsLinux -ValueOnly -ErrorAction SilentlyContinue)
$script:IsMac = [bool](Get-Variable -Name IsMacOS -ValueOnly -ErrorAction SilentlyContinue)
$script:IsWin = -not ($script:IsLin -or $script:IsMac)
# Executable / shared-library suffixes by platform.
$script:ExeExt = if ($script:IsWin) { '.exe' } else { '' }
$script:LibExt = if ($script:IsWin) { 'dll' } elseif ($script:IsMac) { 'dylib' } else { 'so' }

# Linux GPU tooling (cached). When nvidia-smi is absent (e.g. AMD), these give
# real VRAM data: glxinfo (mesa-utils) for the VRAM total, radeontop for live
# VRAM-used + GPU utilization. Both optional - absence degrades gracefully.
$script:HasRadeontop = $false
$script:HasGlxinfo   = $false
$script:HasAmdSmi    = $false
if ($script:IsLin) {
    $script:HasRadeontop = [bool](Get-Command radeontop -ErrorAction SilentlyContinue)
    $script:HasGlxinfo   = [bool](Get-Command glxinfo   -ErrorAction SilentlyContinue)
    $script:HasAmdSmi    = [bool](Get-Command amd-smi   -ErrorAction SilentlyContinue)
}
$script:_rtFile = $null   # radeontop streaming dump file (live VRAM/util), or null
$script:_rtProc = $null   # the radeontop background process, or null

# ============================================================================
# GENERIC PARSERS
# ============================================================================
function ConvertTo-MetricNumber {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return [double]$Value
    }
    $s = ([string]$Value).Trim()
    if (-not $s) { return $null }
    if ($s -match '-?\d+(?:[\.,]\d+)?') {
        $n = $Matches[0].Replace(',', '.')
        try { return [double]::Parse($n, [System.Globalization.CultureInfo]::InvariantCulture) } catch { }
    }
    return $null
}

function ConvertTo-MetricMib {
    param($Value, [string]$Path = '')
    $n = ConvertTo-MetricNumber $Value
    if ($null -eq $n) { return $null }
    $s = if ($null -ne $Value) { ([string]$Value).ToLowerInvariant() } else { '' }
    $p = if ($Path) { $Path.ToLowerInvariant() } else { '' }
    if ($s -match '\b(gib|gb)\b' -or $p -match 'gib|gb') { return $n * 1024 }
    if ($s -match '\b(kib|kb)\b' -or $p -match 'kib|kb') { return $n / 1024 }
    if ($s -match '\b(bytes|byte|b)\b' -or $p -match 'bytes|byte') { return $n / 1MB }
    if ($n -gt 1048576) { return $n / 1MB }  # likely bytes
    return $n
}

function ConvertTo-PowerWatts {
    param($Value, [string]$Path = '')
    $n = ConvertTo-MetricNumber $Value
    if ($null -eq $n) { return $null }
    $s = if ($null -ne $Value) { ([string]$Value).ToLowerInvariant() } else { '' }
    $p = if ($Path) { $Path.ToLowerInvariant() } else { '' }
    if ($s -match 'uw|microwatt' -or $p -match 'uw|micro') { return $n / 1000000 }
    if ($s -match 'mw|milliwatt' -or $p -match 'mw|milli') { return $n / 1000 }
    return $n
}

function Get-JsonScalarLeaves {
    param($Node, [string]$Path = '')
    $out = @()
    if ($null -eq $Node) { return $out }

    if ($Node -is [string] -or $Node -is [ValueType]) {
        $out += [pscustomobject]@{ path = $Path.ToLowerInvariant(); value = $Node }
        return $out
    }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $Node.PSObject.Properties) {
            $childPath = if ($Path) { "$Path.$($p.Name)" } else { $p.Name }
            $out += @(Get-JsonScalarLeaves -Node $p.Value -Path $childPath)
        }
        return $out
    }
    if ($Node -is [System.Collections.IDictionary]) {
        foreach ($k in $Node.Keys) {
            $childPath = if ($Path) { "$Path.$k" } else { [string]$k }
            $out += @(Get-JsonScalarLeaves -Node $Node[$k] -Path $childPath)
        }
        return $out
    }
    if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
        $i = 0
        foreach ($x in $Node) {
            $childPath = if ($Path) { "$Path[$i]" } else { "[$i]" }
            $out += @(Get-JsonScalarLeaves -Node $x -Path $childPath)
            $i++
        }
        return $out
    }
    return $out
}

function Select-FirstNumericLeaf {
    param($Leaves, [scriptblock]$Predicate)
    foreach ($leaf in $Leaves) {
        $n = ConvertTo-MetricNumber $leaf.value
        if ($null -ne $n -and (& $Predicate $leaf.path)) { return $n }
    }
    return $null
}

function Select-FirstMibLeaf {
    param($Leaves, [scriptblock]$Predicate)
    foreach ($leaf in $Leaves) {
        if (& $Predicate $leaf.path) {
            $n = ConvertTo-MetricMib $leaf.value $leaf.path
            if ($null -ne $n) { return $n }
        }
    }
    return $null
}

function Select-FirstWattLeaf {
    param($Leaves, [scriptblock]$Predicate)
    foreach ($leaf in $Leaves) {
        if (& $Predicate $leaf.path) {
            $n = ConvertTo-PowerWatts $leaf.value $leaf.path
            if ($null -ne $n) { return $n }
        }
    }
    return $null
}

function Select-FirstTextLeaf {
    param($Leaves, [scriptblock]$Predicate)
    foreach ($leaf in $Leaves) {
        if ($null -ne $leaf.value -and (& $Predicate $leaf.path)) {
            $s = ([string]$leaf.value).Trim()
            if ($s -and $s -notmatch '^\d+(?:[\.,]\d+)?$') { return $s }
        }
    }
    return $null
}

function ConvertFrom-AmdSmiMetricJson {
    # `amd-smi metric --json` has changed shape across ROCm/amdsmi releases.
    # Instead of binding to one exact schema, flatten scalar JSON paths and
    # select by semantic path fragments.
    param([string]$Text)
    $empty = [ordered]@{ mem_mib = 0; total_mib = 0; power_w = 0.0; temp_c = 0; util_pct = 0 }
    if (-not $Text) { return $empty }
    try { $json = $Text | ConvertFrom-Json } catch { return $empty }
    $leaves = @(Get-JsonScalarLeaves $json)

    $mem = Select-FirstMibLeaf $leaves {
        param($p) ($p -match 'vram|memory') -and ($p -match 'used|usage') -and ($p -notmatch 'total|percent|percentage|util')
    }
    $total = Select-FirstMibLeaf $leaves {
        param($p) ($p -match 'vram|memory') -and ($p -match 'total|size') -and ($p -notmatch 'used|usage|free')
    }
    $power = Select-FirstWattLeaf $leaves {
        param($p) ($p -match 'power') -and ($p -notmatch 'cap|limit|max')
    }
    $temp = Select-FirstNumericLeaf $leaves {
        param($p) ($p -match 'temp|temperature') -and ($p -notmatch 'memory')
    }
    $util = Select-FirstNumericLeaf $leaves {
        param($p) (($p -match 'gfx|gpu') -and ($p -match 'util|usage|busy|activity')) -and ($p -notmatch 'memory|vram')
    }

    return [ordered]@{
        mem_mib   = if ($null -ne $mem)   { [int][math]::Round($mem) }   else { 0 }
        total_mib = if ($null -ne $total) { [int][math]::Round($total) } else { 0 }
        power_w   = if ($null -ne $power) { [math]::Round($power, 1) }    else { 0.0 }
        temp_c    = if ($null -ne $temp)  { [int][math]::Round($temp) }   else { 0 }
        util_pct  = if ($null -ne $util)  { [int][math]::Round($util) }   else { 0 }
    }
}

function ConvertFrom-AmdSmiStaticJson {
    param([string]$Text)
    $empty = [ordered]@{ gpu_name = $null; vram_total_mib = 0 }
    if (-not $Text) { return $empty }
    try { $json = $Text | ConvertFrom-Json } catch { return $empty }
    $leaves = @(Get-JsonScalarLeaves $json)
    $name = Select-FirstTextLeaf $leaves {
        param($p) ($p -match 'market.*name|product.*name|asic.*name|board.*name|gpu.*name|name') -and ($p -notmatch 'driver|version|vendor')
    }
    $total = Select-FirstMibLeaf $leaves {
        param($p) ($p -match 'vram|memory') -and ($p -match 'total|size') -and ($p -notmatch 'used|usage|free')
    }
    return [ordered]@{
        gpu_name       = $name
        vram_total_mib = if ($null -ne $total) { [int][math]::Round($total) } else { 0 }
    }
}

function ConvertFrom-MacDisplaysData {
    param([string]$Text)
    $name = $null
    $metal = $false
    foreach ($line in ($Text -split "`r?`n")) {
        if (-not $name -and $line -match '^\s*(Chipset Model|Model|Graphics)\s*:\s*(.+?)\s*$') {
            $name = $Matches[2].Trim()
        }
        if ($line -match '^\s*Metal Support\s*:\s*(.+?)\s*$') {
            $metal = ($Matches[1].Trim() -notmatch 'Unsupported|None|No')
        }
    }
    return [ordered]@{ gpu_name = $name; metal_supported = [bool]$metal }
}

# ============================================================================
# LINUX HELPERS (sysfs / /proc fallbacks for what nvidia-smi + WMI give on Windows)
# ============================================================================
function Get-LinuxCpuCounts {
    # Physical cores and logical threads from /proc/cpuinfo. Physical = unique
    # (physical id, core id) pairs; logical = count of 'processor' entries.
    # Falls back to logical==physical when topology fields are missing (some
    # VMs / ARM kernels omit them).
    $logical = 0; $pairs = @{}; $phys = ''
    foreach ($line in (Get-Content /proc/cpuinfo -ErrorAction SilentlyContinue)) {
        if     ($line -match '^processor\s*:')          { $logical++ }
        elseif ($line -match '^physical id\s*:\s*(\d+)') { $phys = $Matches[1] }
        elseif ($line -match '^core id\s*:\s*(\d+)')     { $pairs["$phys/$($Matches[1])"] = $true }
    }
    $physical = $pairs.Count
    if ($physical -le 0) { $physical = $logical }
    if ($logical  -le 0) { $logical  = $physical }
    return @{ physical = $physical; logical = $logical }
}

function Get-LinuxGpuName {
    # Best-effort GPU name from lspci. No VRAM: the radeon driver and older
    # cards don't expose mem_info_vram, and VRAM-budget planning is opt-in on
    # Linux (the user sets hardware.vram_total_mib if they want it).
    try {
        $line = (lspci 2>$null | Select-String -Pattern 'VGA|3D controller|Display' | Select-Object -First 1)
        if ($line) {
            $name = (($line.ToString() -split ':\s*', 3)[-1]).Trim()
            return ($name -replace '\s*\(rev [0-9a-f]+\)\s*$', '')   # drop the trailing "(rev 05)"
        }
    } catch { }
    return $null
}

function Invoke-AmdSmiJson {
    param([string[]]$Arguments)
    if (-not $script:HasAmdSmi) { return $null }
    try {
        $out = & amd-smi @Arguments --json 2>$null | Out-String
        if ($LASTEXITCODE -eq 0 -and $out.Trim()) { return $out }
    } catch { }
    return $null
}

function Get-AmdSmiMetricSnapshot {
    if (-not $script:HasAmdSmi) { return $null }
    $out = Invoke-AmdSmiJson -Arguments @('metric')
    if (-not $out) { return $null }
    $snap = ConvertFrom-AmdSmiMetricJson $out
    $hasAny = ($snap.mem_mib -gt 0 -or $snap.total_mib -gt 0 -or $snap.power_w -gt 0 -or $snap.temp_c -gt 0 -or $snap.util_pct -gt 0)
    if (-not $hasAny) { return $null }
    return $snap
}

function Get-AmdSmiStaticInfo {
    if (-not $script:HasAmdSmi) { return [ordered]@{ gpu_name = $null; vram_total_mib = 0 } }
    $out = Invoke-AmdSmiJson -Arguments @('static')
    $info = ConvertFrom-AmdSmiStaticJson $out
    if (-not $info.gpu_name -or -not $info.vram_total_mib) {
        $metric = Get-AmdSmiMetricSnapshot
        if ($metric -and $metric.total_mib -gt 0) { $info.vram_total_mib = $metric.total_mib }
    }
    return $info
}

$script:_linuxHwmonTemp = $null   # cached path to the GPU temp sysfs node
function Get-LinuxGpuTempC {
    # GPU temperature (deg C) from the amdgpu/radeon hwmon node. Caches the
    # resolved path; returns 0 when no GPU temp sensor is exposed.
    try {
        if (-not $script:_linuxHwmonTemp) {
            $f = Get-ChildItem /sys/class/drm/card*/device/hwmon/hwmon*/temp1_input -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($f) { $script:_linuxHwmonTemp = $f.FullName }
        }
        if ($script:_linuxHwmonTemp -and (Test-Path $script:_linuxHwmonTemp)) {
            $milli = [int]((Get-Content $script:_linuxHwmonTemp -ErrorAction SilentlyContinue | Select-Object -First 1))
            return [int]($milli / 1000)
        }
    } catch { }
    return 0
}

$script:_linuxHwmonPower = $null   # cached path to GPU power sensor ('' = none)
function Get-LinuxGpuPowerW {
    # GPU power draw (W) from the card's own hwmon. amdgpu (discrete / newer
    # cards) exposes power1_average in microwatts; the old radeon driver on
    # APUs exposes no GPU-isolated power, so this returns 0 there. (APU package
    # power - CPU+iGPU combined - lives under the separate fam15h_power hwmon and
    # is intentionally NOT used here, since it isn't GPU-isolated.)
    try {
        if ($null -eq $script:_linuxHwmonPower) {
            $f = Get-ChildItem /sys/class/drm/card*/device/hwmon/hwmon*/power1_average -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $f) { $f = Get-ChildItem /sys/class/drm/card*/device/hwmon/hwmon*/power1_input -ErrorAction SilentlyContinue | Select-Object -First 1 }
            $script:_linuxHwmonPower = if ($f) { $f.FullName } else { '' }
        }
        if ($script:_linuxHwmonPower) {
            $uw = [double]((Get-Content $script:_linuxHwmonPower -ErrorAction SilentlyContinue | Select-Object -First 1))
            return [math]::Round($uw / 1000000, 1)   # microwatts -> W
        }
    } catch { }
    return 0.0
}

function Get-LinuxGpuVramTotalMib {
    # VRAM total (MiB) on Linux without nvidia-smi. Detected once (init), so the
    # ~1s radeontop cost is paid at most once. Order:
    #   1) glxinfo "Video memory: NMB" - exact, but needs an X display.
    #   2) radeontop - derive total from "used / used%", works headless.
    # Returns 0 when neither tool is available (VRAM-budget planning stays opt-in).
    if ($script:HasAmdSmi) {
        try {
            $info = Get-AmdSmiStaticInfo
            if ($info.vram_total_mib -gt 0) { return [int]$info.vram_total_mib }
        } catch { }
    }
    if ($script:HasGlxinfo) {
        try {
            $m = glxinfo -B 2>$null | Select-String -Pattern 'Video memory:\s*(\d+)\s*MB' | Select-Object -First 1
            if ($m) { return [int]$m.Matches[0].Groups[1].Value }
        } catch { }
    }
    if ($script:HasRadeontop) {
        try {
            $l = radeontop -d - -l 1 -i 1 2>$null | Select-String -Pattern '\bvram\b' | Select-Object -First 1
            if ($l -and $l.Line -match 'vram\s+([\d.]+)%\s+([\d.]+)mb') {
                $pct = [double]$Matches[1]; $usedMb = [double]$Matches[2]
                if ($pct -gt 0) { return [int][math]::Round($usedMb / ($pct / 100)) }
            }
        } catch { }
    }
    return 0
}

function Start-LinuxGpuMonitor {
    # Stream radeontop to a temp file the poll loop can tail cheaply. A one-shot
    # radeontop costs ~1s (its first sample); a background stream costs nothing
    # per tick. No-op off Linux or when radeontop is absent.
    if (-not $script:IsLin -or -not $script:HasRadeontop) { return }
    Stop-LinuxGpuMonitor
    try {
        $script:_rtFile = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-rt-" + ([guid]::NewGuid().ToString('N')) + ".txt")
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName  = 'radeontop'
        $psi.Arguments = "-d `"$($script:_rtFile)`" -i 0.5"   # sample every 0.5s, matching the poll loop
        $psi.RedirectStandardOutput = $true   # swallow the "Dumping to ..." banner
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow  = $true
        $script:_rtProc = [System.Diagnostics.Process]::Start($psi)
        # Drain pipes async so they never fill and block radeontop.
        $script:_rtProc.StandardOutput.ReadToEndAsync() | Out-Null
        $script:_rtProc.StandardError.ReadToEndAsync()  | Out-Null
        # Wait briefly for the first sample so baseline reads (VRAM/GTT) are
        # real, not 0. radeontop's first line lands ~1s after start.
        $deadline = (Get-Date).AddSeconds(2.5)
        while ((Get-Date) -lt $deadline) {
            if ((Test-Path $script:_rtFile) -and
                ((Get-Content -LiteralPath $script:_rtFile -Tail 1 -ErrorAction SilentlyContinue) -match '\bvram\b')) { break }
            Start-Sleep -Milliseconds 100
        }
    } catch { $script:_rtFile = $null; $script:_rtProc = $null }
}

function Stop-LinuxGpuMonitor {
    if ($script:_rtProc) {
        try { if (-not $script:_rtProc.HasExited) { $script:_rtProc.Kill() } } catch { }
        $script:_rtProc = $null
    }
    if ($script:_rtFile) {
        try { Remove-Item -LiteralPath $script:_rtFile -Force -ErrorAction SilentlyContinue } catch { }
        $script:_rtFile = $null
    }
}

function Get-GpuSnapshotLinux {
    # No nvidia-smi: read live VRAM-used + GPU utilization from the radeontop
    # stream (Start-LinuxGpuMonitor), temperature + power from sysfs hwmon.
    # Everything degrades to 0 when the source is absent (e.g. no radeontop, or
    # the radeon driver exposes no GPU power sensor).
    $mem = 0; $util = 0; $power = 0.0; $temp = 0
    $amd = Get-AmdSmiMetricSnapshot
    if ($amd) {
        $mem = [int]$amd.mem_mib
        $util = [int]$amd.util_pct
        $power = [double]$amd.power_w
        $temp = [int]$amd.temp_c
    }
    if ($script:_rtFile -and (Test-Path $script:_rtFile)) {
        try {
            $line = Get-Content -LiteralPath $script:_rtFile -Tail 4 -ErrorAction SilentlyContinue |
                    Select-String -Pattern '\bvram\b' | Select-Object -Last 1
            if ($line) {
                $t = $line.Line
                if ($mem -le 0 -and $t -match 'vram\s+[\d.]+%\s+([\d.]+)mb') { $mem  = [int][double]$Matches[1] }
                if ($util -le 0 -and $t -match '\bgpu\s+([\d.]+)%')          { $util = [int][double]$Matches[1] }
            }
        } catch { }
    }
    if ($power -le 0) { $power = Get-LinuxGpuPowerW }
    if ($temp -le 0)  { $temp  = Get-LinuxGpuTempC }
    return @{ mem_mib = $mem; power_w = $power; temp_c = $temp; util_pct = $util }
}

function Get-LinuxGpuVramFresh {
    # One-shot radeontop read of VRAM-used (MiB) for the hottest-moment
    # snapshot. The streamed dump file (Start-LinuxGpuMonitor) block-buffers its
    # writes, so on a fast bench it can lag several seconds and the tail still
    # shows the idle baseline when the model is already resident on the GPU.
    # nvidia-smi on Windows is instant and accurate; this gives Linux the same
    # fidelity at the one moment it matters. Costs ~2s (radeontop's first sample
    # has a register-read warmup), called once per run at the post-bench peak.
    # Returns -1 when unavailable so the caller keeps the streamed value.
    if (-not $script:IsLin) { return -1 }
    $amd = Get-AmdSmiMetricSnapshot
    if ($amd) { return [int]$amd.mem_mib }
    if (-not $script:HasRadeontop) { return -1 }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName  = 'radeontop'
        $psi.Arguments = '-d - -l 2 -i 0.3'   # 2 dumps to stdout, then self-exit
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow  = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.StandardError.ReadToEnd() | Out-Null
        if (-not $p.WaitForExit(4000)) { try { $p.Kill() } catch { } }
        $last = $out -split "`n" | Select-String -Pattern '\bvram\b' | Select-Object -Last 1
        if ($last -and $last.Line -match 'vram\s+[\d.]+%\s+([\d.]+)mb') {
            return [int][double]$Matches[1]
        }
    } catch { }
    return -1
}

function Invoke-MacScalar {
    param([string[]]$Arguments)
    if (-not $script:IsMac) { return $null }
    try {
        $cmd = $Arguments[0]
        $rest = @($Arguments | Select-Object -Skip 1)
        $out = & $cmd @rest 2>$null | Out-String
        $s = $out.Trim()
        if ($s) { return $s }
    } catch { }
    return $null
}

function Get-MacCpuCounts {
    $physical = ConvertTo-MetricNumber (Invoke-MacScalar @('sysctl','-n','hw.physicalcpu'))
    $logical  = ConvertTo-MetricNumber (Invoke-MacScalar @('sysctl','-n','hw.logicalcpu'))
    if ($null -eq $physical) { $physical = $logical }
    if ($null -eq $logical)  { $logical = $physical }
    return @{ physical = if ($null -ne $physical) { [int]$physical } else { $null }; logical = if ($null -ne $logical) { [int]$logical } else { $null } }
}

function Get-MacCpuModel {
    $brand = Invoke-MacScalar @('sysctl','-n','machdep.cpu.brand_string')
    if ($brand) { return $brand }
    $chip = Invoke-MacScalar @('sysctl','-n','machdep.cpu.brand')
    if ($chip) { return $chip }
    return $null
}

function Get-MacMemTotalMib {
    $bytes = ConvertTo-MetricNumber (Invoke-MacScalar @('sysctl','-n','hw.memsize'))
    if ($null -ne $bytes -and $bytes -gt 0) { return [int]($bytes / 1MB) }
    return $null
}

function Get-MacAvailableMemoryMib {
    if (-not $script:IsMac) { return -1 }
    try {
        $pageSize = ConvertTo-MetricNumber (Invoke-MacScalar @('sysctl','-n','hw.pagesize'))
        if (-not $pageSize) { $pageSize = 4096 }
        $out = vm_stat 2>$null | Out-String
        $pages = 0
        foreach ($line in ($out -split "`r?`n")) {
            if ($line -match 'Pages (free|inactive|speculative):\s+([\d.]+)') {
                $pages += [int64]($Matches[2] -replace '\.', '')
            }
        }
        if ($pages -gt 0) { return [int](($pages * $pageSize) / 1MB) }
    } catch { }
    return -1
}

function Get-MacGpuInfo {
    if (-not $script:IsMac) { return [ordered]@{ gpu_name = $null; metal_supported = $false } }
    try {
        $out = system_profiler SPDisplaysDataType 2>$null | Out-String
        $info = ConvertFrom-MacDisplaysData $out
        if ($info.gpu_name) { return $info }
    } catch { }
    $cpu = Get-MacCpuModel
    if ($cpu -and $cpu -match 'Apple') {
        return [ordered]@{ gpu_name = $cpu; metal_supported = $true }
    }
    return [ordered]@{ gpu_name = $null; metal_supported = $false }
}


# ============================================================================
# HARDWARE DETECTION (for `init`)
# ============================================================================
function Get-DetectedHardware {
    $hw = @{
        vram_total_mib          = $null
        gpu_name                = $null
        gpu_compute_cap         = $null
        gpu_backend_hint        = $null
        memory_unified          = $false
        unified_memory_total_mib= $null
        cpu_cores_physical      = $null
        cpu_threads_logical     = $null
    }
    # GPU: nvidia-smi works on both Windows and Linux when an NVIDIA driver is
    # present. On non-NVIDIA Linux (e.g. an AMD APU) it's absent; degrade to a
    # best-effort name from lspci and leave vram_total_mib null.
    try {
        $gpu = (nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        if ($gpu) {
            $parts = $gpu -split ',\s*'
            $hw.gpu_name        = $parts[0].Trim()
            $hw.vram_total_mib  = [int]$parts[1].Trim()
            $hw.gpu_compute_cap = $parts[2].Trim()
            $hw.gpu_backend_hint = "cuda"
        }
    } catch { }
    if ($script:IsLin) {
        if (-not $hw.gpu_name -or -not $hw.vram_total_mib) {
            $amd = Get-AmdSmiStaticInfo
            if (-not $hw.gpu_name -and $amd.gpu_name) { $hw.gpu_name = $amd.gpu_name }
            if (-not $hw.vram_total_mib -and $amd.vram_total_mib -gt 0) { $hw.vram_total_mib = [int]$amd.vram_total_mib }
            if ($amd.gpu_name -or $script:HasAmdSmi) { $hw.gpu_backend_hint = "hip" }
        }
        if (-not $hw.gpu_name)       { $hw.gpu_name = Get-LinuxGpuName }
        if (-not $hw.vram_total_mib) {
            $v = Get-LinuxGpuVramTotalMib   # glxinfo / radeontop (AMD); 0 if neither
            if ($v -gt 0) { $hw.vram_total_mib = $v }
        }
        if (-not $hw.gpu_backend_hint -and $hw.gpu_name -and $hw.gpu_name -match 'AMD|Radeon') { $hw.gpu_backend_hint = "vulkan" }
    } elseif ($script:IsMac) {
        $macGpu = Get-MacGpuInfo
        if (-not $hw.gpu_name -and $macGpu.gpu_name) { $hw.gpu_name = $macGpu.gpu_name }
        if ($macGpu.metal_supported) { $hw.gpu_backend_hint = "metal" }
        $mem = Get-MacMemTotalMib
        if ($mem) {
            $hw.memory_unified = $true
            $hw.unified_memory_total_mib = $mem
            if (-not $hw.vram_total_mib) { $hw.vram_total_mib = $mem }
        }
    }
    # CPU: WMI on Windows, /proc/cpuinfo on Linux, sysctl on macOS.
    if ($script:IsWin) {
        try {
            $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cpu) {
                $hw.cpu_cores_physical  = [int]$cpu.NumberOfCores
                $hw.cpu_threads_logical = [int]$cpu.NumberOfLogicalProcessors
            }
        } catch { }
    } elseif ($script:IsMac) {
        try {
            $cores = Get-MacCpuCounts
            $hw.cpu_cores_physical  = $cores.physical
            $hw.cpu_threads_logical = $cores.logical
        } catch { }
    } else {
        try {
            $cores = Get-LinuxCpuCounts
            $hw.cpu_cores_physical  = $cores.physical
            $hw.cpu_threads_logical = $cores.logical
        } catch { }
    }
    return $hw
}


