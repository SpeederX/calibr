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
if ($script:IsLin) {
    $script:HasRadeontop = [bool](Get-Command radeontop -ErrorAction SilentlyContinue)
    $script:HasGlxinfo   = [bool](Get-Command glxinfo   -ErrorAction SilentlyContinue)
}
$script:_rtFile = $null   # radeontop streaming dump file (live VRAM/util), or null
$script:_rtProc = $null   # the radeontop background process, or null

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
    $mem = 0; $util = 0
    if ($script:_rtFile -and (Test-Path $script:_rtFile)) {
        try {
            $line = Get-Content -LiteralPath $script:_rtFile -Tail 4 -ErrorAction SilentlyContinue |
                    Select-String -Pattern '\bvram\b' | Select-Object -Last 1
            if ($line) {
                $t = $line.Line
                if ($t -match 'vram\s+[\d.]+%\s+([\d.]+)mb') { $mem  = [int][double]$Matches[1] }
                if ($t -match '\bgpu\s+([\d.]+)%')           { $util = [int][double]$Matches[1] }
            }
        } catch { }
    }
    return @{ mem_mib = $mem; power_w = (Get-LinuxGpuPowerW); temp_c = (Get-LinuxGpuTempC); util_pct = $util }
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
    if (-not $script:IsLin -or -not $script:HasRadeontop) { return -1 }
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


# ============================================================================
# HARDWARE DETECTION (for `init`)
# ============================================================================
function Get-DetectedHardware {
    $hw = @{
        vram_total_mib       = $null
        gpu_name             = $null
        gpu_compute_cap      = $null
        cpu_cores_physical   = $null
        cpu_threads_logical  = $null
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
        }
    } catch { }
    if ($script:IsLin) {
        if (-not $hw.gpu_name)       { $hw.gpu_name = Get-LinuxGpuName }
        if (-not $hw.vram_total_mib) {
            $v = Get-LinuxGpuVramTotalMib   # glxinfo / radeontop (AMD); 0 if neither
            if ($v -gt 0) { $hw.vram_total_mib = $v }
        }
    }
    # CPU: WMI on Windows, /proc/cpuinfo on Linux/macOS.
    if ($script:IsWin) {
        try {
            $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cpu) {
                $hw.cpu_cores_physical  = [int]$cpu.NumberOfCores
                $hw.cpu_threads_logical = [int]$cpu.NumberOfLogicalProcessors
            }
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


