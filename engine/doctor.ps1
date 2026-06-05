# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.
#
# `doctor` is the sanity-check / preflight layer. It detects whether calibr can
# run at all (and whether GPU inference is possible), explains what's missing,
# and gives the exact remediation per problem. Two output forms share one data
# contract:
#   - human checklist  (calibr doctor [-Extended])
#   - JSON bundle       (calibr doctor -Json | -Export [path])
# The JSON is what the CLI's DoctorView renders (navigable rows -> remediation)
# and what users attach to "unable to start" GitHub issues. Remediation strings
# are NOT generated at runtime: they are the known failure modes we already
# catalogued (see open-points.md "GPU-readiness check"), with light dynamic
# slot-ins (package manager, configured paths).

# ============================================================================
# PURE PARSERS (unit-tested in tests/Helpers.Tests.ps1)
# ============================================================================
function ConvertFrom-UeventDriver {
    # Extract DRIVER=<name> from a single sysfs `uevent` file's contents.
    param([string]$Text)
    if (-not $Text) { return $null }
    $m = [regex]::Match($Text, '(?m)^DRIVER=(\S+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function ConvertFrom-CpuinfoFlags {
    # Return a hashtable of the instruction-set flags calibr cares about,
    # each $true/$false, parsed from /proc/cpuinfo text. The AVX2/FMA/BMI2
    # trio is what stock llama.cpp prebuilts assume; their absence is the
    # SIGILL gotcha this dev box hit.
    param([string]$Text)
    $want = @('avx','avx2','fma','bmi1','bmi2','f16c','sse4_2','avx512f')
    $present = [ordered]@{}
    foreach ($f in $want) { $present[$f] = $false }
    if ($Text) {
        $m = [regex]::Match($Text, '(?m)^flags\s*:\s*(.+)$')
        if ($m.Success) {
            $set = @{}
            foreach ($tok in ($m.Groups[1].Value -split '\s+')) { if ($tok) { $set[$tok] = $true } }
            foreach ($f in $want) { if ($set.ContainsKey($f)) { $present[$f] = $true } }
        }
    }
    return $present
}

function ConvertFrom-VulkanSummary {
    # Parse `vulkaninfo --summary` into an array of devices. isHardware is
    # false for the llvmpipe software rasterizer (deviceType ...CPU) - the
    # signal that "Vulkan exists but there's no real GPU behind it".
    param([string]$Text)
    $devices = @()
    $name = $null; $type = $null
    $flush = {
        if ($name) {
            $hw = ($type -and $type -notmatch 'CPU')
            $script:_vkAcc += [pscustomobject]@{ name = $name; type = $type; isHardware = [bool]$hw }
        }
    }
    $script:_vkAcc = @()
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*GPU\d+\s*:') {
            & $flush; $name = $null; $type = $null
        } elseif ($line -match 'deviceName\s*=\s*(.+?)\s*$') {
            $name = $Matches[1].Trim()
        } elseif ($line -match 'deviceType\s*=\s*(\S+)') {
            $type = $Matches[1].Trim()
        }
    }
    & $flush
    $devices = $script:_vkAcc
    Remove-Variable -Name _vkAcc -Scope script -ErrorAction SilentlyContinue
    return ,$devices
}

function ConvertFrom-OsRelease {
    # Pull NAME + VERSION_ID out of /etc/os-release text.
    param([string]$Text)
    $name = $null; $ver = $null
    if ($Text) {
        $mn = [regex]::Match($Text, '(?m)^NAME="?(.*?)"?\s*$');       if ($mn.Success) { $name = $mn.Groups[1].Value }
        $mv = [regex]::Match($Text, '(?m)^VERSION_ID="?(.*?)"?\s*$'); if ($mv.Success) { $ver  = $mv.Groups[1].Value }
    }
    return @{ name = $name; versionId = $ver }
}

# ============================================================================
# IO WRAPPERS (thin; the parsing they delegate to is tested above)
# ============================================================================
function Get-LinuxKernelGpuDriver {
    # The kernel driver bound to the GPU, read from sysfs. Prefers a real GPU
    # driver over framebuffer stubs. amdgpu => RADV hardware Vulkan works;
    # radeon (legacy, CIK/SI) => RADV unsupported, software-only.
    if (-not $script:IsLin) { return $null }
    $pref = @('amdgpu','nvidia','radeon','i915','nouveau','xe')
    $found = @()
    try {
        foreach ($f in (Get-ChildItem /sys/class/drm/card*/device/uevent -ErrorAction SilentlyContinue)) {
            $d = ConvertFrom-UeventDriver (Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue)
            if ($d) { $found += $d }
        }
    } catch { }
    foreach ($p in $pref) { if ($found -contains $p) { return $p } }
    if ($found.Count -gt 0) { return $found[0] }
    return $null
}

function Get-LinuxCpuFlags {
    if (-not $script:IsLin) { return $null }
    return ConvertFrom-CpuinfoFlags (Get-Content /proc/cpuinfo -Raw -ErrorAction SilentlyContinue)
}

function Get-LinuxCpuModel {
    if (-not $script:IsLin) { return $null }
    try {
        $m = Select-String -Path /proc/cpuinfo -Pattern '^model name\s*:\s*(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value.Trim() }
    } catch { }
    return $null
}

function Get-LinuxMemTotalMib {
    if (-not $script:IsLin) { return $null }
    try {
        $m = Select-String -Path /proc/meminfo -Pattern '^MemTotal:\s+(\d+)\s*kB' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { return [int]([int64]$m.Matches[0].Groups[1].Value / 1024) }
    } catch { }
    return $null
}

function Get-VulkanDevices {
    # `vulkaninfo --summary` parsed to devices. Returns $null when vulkaninfo
    # is absent (distinct from "ran but found only llvmpipe").
    if (-not (Get-Command vulkaninfo -ErrorAction SilentlyContinue)) { return $null }
    try {
        $out = vulkaninfo --summary 2>$null | Out-String
        return (ConvertFrom-VulkanSummary $out)
    } catch { return $null }
}

function Get-DoctorOsInfo {
    if ($script:IsLin) {
        $os = ConvertFrom-OsRelease (Get-Content /etc/os-release -Raw -ErrorAction SilentlyContinue)
        $kernel = $null
        try { $kernel = (uname -r 2>$null | Out-String).Trim() } catch { }
        $name = if ($os.name) { if ($os.versionId) { "$($os.name) $($os.versionId)" } else { $os.name } } else { 'Linux' }
        return @{ platform = 'linux'; name = $name; kernel = $kernel }
    } elseif ($script:IsMac) {
        $name = 'macOS'
        try { $name = "macOS $((sw_vers -productVersion 2>$null | Out-String).Trim())" } catch { }
        return @{ platform = 'macos'; name = $name; kernel = $null }
    } else {
        $name = 'Windows'
        try { $name = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption } catch { }
        return @{ platform = 'windows'; name = $name; kernel = [string][System.Environment]::OSVersion.Version }
    }
}

function Get-LinuxPkgInstall {
    # The install-command prefix for the detected distro family. Package NAMES
    # below assume Debian/Ubuntu; other families may name them differently.
    if (Get-Command apt-get -ErrorAction SilentlyContinue) { return 'sudo apt install' }
    if (Get-Command dnf     -ErrorAction SilentlyContinue) { return 'sudo dnf install' }
    if (Get-Command pacman  -ErrorAction SilentlyContinue) { return 'sudo pacman -S' }
    return 'sudo apt install'
}

# ============================================================================
# REDACTION + LOG CAPPING
# ============================================================================
function Protect-DoctorText {
    # Redact the bundle so it's safe to attach to a public issue: home dir -> ~,
    # hostname -> <host>. (-Extended changes log volume, never redaction.)
    param([string]$Text)
    if (-not $Text) { return $Text }
    if ($HOME) { $Text = $Text.Replace($HOME, '~') }
    try {
        $hn = [System.Net.Dns]::GetHostName()
        if ($hn) { $Text = $Text -replace [regex]::Escape($hn), '<host>' }
    } catch { }
    return $Text
}

function Limit-DoctorLog {
    param([string]$Text, [int]$MaxLines)
    if (-not $Text) { return '' }
    $t = Protect-DoctorText $Text
    if ($MaxLines -le 0) { return $t }   # extended: full log
    $lines = $t -split "`r?`n"
    if ($lines.Count -le $MaxLines) { return $t }
    return (($lines | Select-Object -Last $MaxLines) -join "`n")
}

function Invoke-DoctorProbe {
    # Run a native command, capturing stdout+stderr and the exit code. ran=$false
    # when the command isn't found (so callers can say "missing" vs "ran but
    # failed", e.g. a SIGILL exit). Never throws.
    param([string]$FilePath, [string[]]$Arguments = @())
    $r = @{ ran = $false; exitCode = $null; output = '' }
    try {
        $out = & $FilePath @Arguments 2>&1 | Out-String
        $r.ran = $true
        $r.exitCode = $LASTEXITCODE
        $r.output = $out.TrimEnd()
    } catch {
        $r.output = $_.Exception.Message
    }
    return $r
}

function New-DepResult {
    param(
        [string]$Name, [string]$Kind, [bool]$Required, [bool]$Present,
        $Version = $null, [string]$Command = $null, [string]$Log = '',
        [string]$Check, [string]$Detail = $null, [string]$Remediation = $null
    )
    return [ordered]@{
        name        = $Name
        kind        = $Kind
        required    = $Required
        present     = $Present
        version     = $Version
        command     = $Command
        log         = $Log
        check       = $Check          # ok | warning | fail | missing | skipped
        detail      = $Detail
        remediation = $Remediation
    }
}

# ============================================================================
# DEP CHECKS
# ============================================================================
function Get-DoctorDeps {
    param($cfg, [int]$LogLines)
    $deps = [System.Collections.Generic.List[object]]::new()
    $pkg  = if ($script:IsLin) { Get-LinuxPkgInstall } else { $null }
    $gpuName = if ($cfg.hardware) { $cfg.hardware.gpu_name } else { $null }
    $isAmd    = [bool]($gpuName -and $gpuName -match 'AMD|Radeon')
    $isNvidia = [bool]($gpuName -and $gpuName -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Tesla')

    # --- pwsh (we're running in it) ---
    $deps.Add((New-DepResult -Name 'powershell' -Kind 'runtime' -Required $true -Present $true `
        -Version ([string]$PSVersionTable.PSVersion) -Check 'ok' `
        -Detail "PowerShell $($PSVersionTable.PSEdition)"))

    # --- node (the CLI runtime) ---
    $node = Invoke-DoctorProbe -FilePath 'node' -Arguments @('--version')
    if (-not $node.ran) {
        $deps.Add((New-DepResult -Name 'node' -Kind 'runtime' -Required $true -Present $false `
            -Command 'node --version' -Check 'missing' `
            -Detail 'Node.js not found; the calibr CLI needs Node 18+' `
            -Remediation $(if ($script:IsWin) { 'Install Node.js 18+ from https://nodejs.org' } else { "$pkg nodejs  (or use nvm; need >=18)" })))
    } else {
        $ver = $node.output.Trim()
        $major = 0; $mm = [regex]::Match($ver, 'v(\d+)'); if ($mm.Success) { $major = [int]$mm.Groups[1].Value }
        if ($major -gt 0 -and $major -lt 18) {
            $deps.Add((New-DepResult -Name 'node' -Kind 'runtime' -Required $true -Present $true -Version $ver `
                -Command 'node --version' -Log (Limit-DoctorLog $node.output $LogLines) -Check 'warning' `
                -Detail "Node $ver is older than the supported 18+" `
                -Remediation $(if ($script:IsWin) { 'Upgrade Node.js from https://nodejs.org' } else { "$pkg nodejs  (need >=18; consider nvm)" })))
        } else {
            $deps.Add((New-DepResult -Name 'node' -Kind 'runtime' -Required $true -Present $true -Version $ver `
                -Command 'node --version' -Log (Limit-DoctorLog $node.output $LogLines) -Check 'ok' -Detail "Node $ver"))
        }
    }

    # --- llama-server (the engine) ---
    $exe = if ($cfg.llama_server_exe) { $cfg.llama_server_exe } else { '' }
    if (-not $exe -or -not (Test-Path $exe)) {
        $found = @(Find-LlamaServerExe)
        if ($found.Count -gt 0) { $exe = $found[0] }
    }
    if (-not $exe -or -not (Test-Path $exe)) {
        $deps.Add((New-DepResult -Name 'llama-server' -Kind 'runtime' -Required $true -Present $false `
            -Check 'missing' -Detail 'llama-server not configured or not found on disk' `
            -Remediation 'Download a llama.cpp build (https://github.com/ggml-org/llama.cpp/releases), then: calibr init -LlamaServer <path>'))
    } else {
        $probe = Invoke-DoctorProbe -FilePath $exe -Arguments @('--version')
        $ver = Get-LlamaServerVersion -Exe $exe
        # SIGILL on Linux surfaces as exit 132 (128+SIGILL); a crash with no
        # parseable version is the classic AVX2/BMI2-missing prebuilt failure.
        $crashed = ($probe.ran -and $probe.exitCode -ne 0 -and (-not $ver -or $ver -eq 'unknown'))
        if ($crashed) {
            $deps.Add((New-DepResult -Name 'llama-server' -Kind 'runtime' -Required $true -Present $true `
                -Version $ver -Command "$exe --version" -Log (Limit-DoctorLog $probe.output $LogLines) -Check 'fail' `
                -Detail "llama-server failed to run (exit $($probe.exitCode)) - likely an illegal instruction: this prebuilt needs CPU features this machine lacks (AVX2/FMA/BMI2)" `
                -Remediation 'Build llama.cpp from source for this CPU: cmake -B build -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF && cmake --build build --target llama-server'))
        } else {
            $deps.Add((New-DepResult -Name 'llama-server' -Kind 'runtime' -Required $true -Present $true `
                -Version $ver -Command "$exe --version" -Log (Limit-DoctorLog $probe.output $LogLines) -Check 'ok' `
                -Detail "build $ver"))
        }
    }

    # --- CPU instruction set (Linux; the SIGILL trap) ---
    if ($script:IsLin) {
        $flags = Get-LinuxCpuFlags
        $missing = @(); foreach ($f in @('avx2','fma','bmi2')) { if (-not $flags[$f]) { $missing += $f } }
        if ($missing.Count -gt 0) {
            $deps.Add((New-DepResult -Name 'cpu-instructions' -Kind 'cpu' -Required $false -Present $true `
                -Check 'warning' -Detail "CPU lacks: $($missing -join ', ') - stock llama.cpp prebuilts may crash with SIGILL" `
                -Remediation 'Use a source build with -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF (keep -DGGML_AVX=ON if avx is present)'))
        } else {
            $deps.Add((New-DepResult -Name 'cpu-instructions' -Kind 'cpu' -Required $false -Present $true `
                -Check 'ok' -Detail 'AVX2/FMA/BMI2 present - stock prebuilts are safe'))
        }
    }

    # --- GPU kernel driver (Linux) ---
    if ($script:IsLin) {
        $drv = Get-LinuxKernelGpuDriver
        if (-not $drv) {
            $deps.Add((New-DepResult -Name 'gpu-driver' -Kind 'gpu-driver' -Required $false -Present $false `
                -Check 'skipped' -Detail 'no GPU kernel driver detected in sysfs'))
        } elseif ($drv -eq 'radeon') {
            $deps.Add((New-DepResult -Name 'gpu-driver' -Kind 'gpu-driver' -Required $false -Present $true `
                -Version $drv -Command 'cat /sys/class/drm/card*/device/uevent' -Check 'warning' `
                -Detail 'legacy radeon driver: RADV (hardware Vulkan) does NOT support it - no real GPU offload, only software (llvmpipe)' `
                -Remediation 'Switch the card to amdgpu (experimental for CIK/SI) via kernel params + reboot: GRUB_CMDLINE_LINUX_DEFAULT add "radeon.cik_support=0 radeon.si_support=0 amdgpu.cik_support=1 amdgpu.si_support=1", then update-grub; OR accept CPU-only inference'))
        } else {
            $deps.Add((New-DepResult -Name 'gpu-driver' -Kind 'gpu-driver' -Required $false -Present $true `
                -Version $drv -Command 'cat /sys/class/drm/card*/device/uevent' -Check 'ok' `
                -Detail "$drv kernel driver"))
        }
    }

    # --- Vulkan runtime device (hardware vs llvmpipe) ---
    if (-not $script:IsMac) {
        $vk = Get-VulkanDevices
        if ($null -eq $vk) {
            $deps.Add((New-DepResult -Name 'vulkan-runtime' -Kind 'gpu' -Required $false -Present $false `
                -Command 'vulkaninfo --summary' -Check 'missing' `
                -Detail 'vulkaninfo not available - cannot verify a hardware Vulkan device' `
                -Remediation $(if ($script:IsWin) { 'Install the Vulkan SDK / your GPU vendor driver' } else { "$pkg vulkan-tools mesa-vulkan-drivers" })))
        } else {
            $hw = @($vk | Where-Object { $_.isHardware })
            $log = Limit-DoctorLog (($vk | ForEach-Object { "$($_.name) [$($_.type)]" }) -join "`n") $LogLines
            if ($hw.Count -gt 0) {
                $deps.Add((New-DepResult -Name 'vulkan-runtime' -Kind 'gpu' -Required $false -Present $true `
                    -Command 'vulkaninfo --summary' -Log $log -Check 'ok' -Detail ("hardware Vulkan: " + ($hw[0].name))))
            } else {
                $deps.Add((New-DepResult -Name 'vulkan-runtime' -Kind 'gpu' -Required $false -Present $true `
                    -Command 'vulkaninfo --summary' -Log $log -Check 'warning' `
                    -Detail 'only llvmpipe (software rasterizer) - Vulkan offload would be SLOWER than the native CPU backend' `
                    -Remediation 'Get a hardware GPU onto Vulkan (see gpu-driver), or skip GPU offload and run on CPU'))
            }
        }
    }

    # --- AMD live-metric tooling (Linux + AMD) ---
    if ($script:IsLin -and $isAmd) {
        $deps.Add((New-DepResult -Name 'radeontop' -Kind 'metrics' -Required $false -Present $script:HasRadeontop `
            -Check $(if ($script:HasRadeontop) { 'ok' } else { 'warning' }) `
            -Detail $(if ($script:HasRadeontop) { 'live VRAM-used / util / GTT available' } else { 'no live VRAM/util/GTT (bench records temperature only)' }) `
            -Remediation $(if ($script:HasRadeontop) { $null } else { "$pkg radeontop" })))
        $deps.Add((New-DepResult -Name 'mesa-utils' -Kind 'metrics' -Required $false -Present $script:HasGlxinfo `
            -Check $(if ($script:HasGlxinfo) { 'ok' } else { 'warning' }) `
            -Detail $(if ($script:HasGlxinfo) { 'glxinfo reports VRAM total' } else { 'no glxinfo: VRAM total falls back to radeontop-derived' }) `
            -Remediation $(if ($script:HasGlxinfo) { $null } else { "$pkg mesa-utils" })))
    } else {
        $deps.Add((New-DepResult -Name 'radeontop' -Kind 'metrics' -Required $false -Present $false `
            -Check 'skipped' -Detail 'Linux+AMD only (on Windows/NVIDIA live VRAM comes from nvidia-smi / perf counters)'))
    }

    # --- nvidia-smi (NVIDIA metrics) ---
    if ($isNvidia -or (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        $smi = Invoke-DoctorProbe -FilePath 'nvidia-smi' -Arguments @('--query-gpu=name,memory.total,driver_version','--format=csv,noheader')
        if ($smi.ran -and $smi.exitCode -eq 0) {
            $deps.Add((New-DepResult -Name 'nvidia-smi' -Kind 'metrics' -Required $false -Present $true `
                -Command 'nvidia-smi' -Log (Limit-DoctorLog $smi.output $LogLines) -Check 'ok' -Detail 'NVIDIA metrics + VRAM available'))
        } elseif ($isNvidia) {
            $deps.Add((New-DepResult -Name 'nvidia-smi' -Kind 'metrics' -Required $false -Present $false `
                -Command 'nvidia-smi' -Check 'warning' -Detail 'NVIDIA GPU detected but nvidia-smi missing/failing' `
                -Remediation 'Install the NVIDIA driver (provides nvidia-smi)'))
        }
    }

    # --- Vulkan build toolchain (only relevant if building a Vulkan llama.cpp) ---
    if ($script:IsLin) {
        $hasGlslc   = [bool](Get-Command glslc -ErrorAction SilentlyContinue)
        $hasVkHdr   = (Test-Path '/usr/include/vulkan/vulkan.h')
        $hasSpirvH  = [bool](Get-ChildItem '/usr/include/spirv*' -ErrorAction SilentlyContinue) -or (Test-Path '/usr/include/spirv-headers')
        $ok = $hasGlslc -and $hasVkHdr
        $detailParts = @("glslc=$hasGlslc","vulkan-headers=$hasVkHdr","spirv-headers=$hasSpirvH")
        $deps.Add((New-DepResult -Name 'vulkan-build-toolchain' -Kind 'vulkan-build' -Required $false -Present $ok `
            -Check $(if ($ok) { 'ok' } else { 'warning' }) `
            -Detail ("for compiling a Vulkan llama.cpp: " + ($detailParts -join ', ')) `
            -Remediation $(if ($ok) { $null } else { "$pkg libvulkan-dev glslc spirv-headers vulkan-tools" })))
    }

    # --- llama.cpp backend vs GPU coherence ---
    $exeForBackends = if ($exe) { $exe } else { '' }
    $backends = Get-LlamaBackends -exe $exeForBackends
    $available = @(); foreach ($k in $backends.Keys) { if ($backends[$k]) { $available += $k } }
    $bWarn = @(Test-BackendHealthy -cfg $cfg -backends $backends)
    if ($bWarn.Count -gt 0) {
        $deps.Add((New-DepResult -Name 'llama-backends' -Kind 'backend' -Required $false -Present $true `
            -Log (($available | Sort-Object) -join ', ') -Check 'warning' `
            -Detail ($bWarn -join ' ') -Remediation 'Get a llama.cpp build whose backend matches your GPU (see https://github.com/ggml-org/llama.cpp/releases)'))
    } else {
        $deps.Add((New-DepResult -Name 'llama-backends' -Kind 'backend' -Required $false -Present $true `
            -Log (($available | Sort-Object) -join ', ') -Check 'ok' -Detail ("backends: " + (($available | Sort-Object) -join ', '))))
    }

    return ,$deps
}

# ============================================================================
# REPORT ASSEMBLY
# ============================================================================
function Get-DoctorSystemInfo {
    param($cfg)
    $os = Get-DoctorOsInfo
    $hw = $cfg.hardware
    # CPU
    $cpuModel = if ($script:IsLin) { Get-LinuxCpuModel } else { $hw.gpu_name }   # placeholder fixed below
    if (-not $script:IsLin) {
        try { $cpuModel = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name } catch { $cpuModel = $null }
    }
    $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $flags = if ($script:IsLin) { Get-LinuxCpuFlags } else { $null }
    $cpu = [ordered]@{
        model          = $cpuModel
        arch           = $arch
        coresPhysical  = $hw.cpu_cores_physical
        threadsLogical = $hw.cpu_threads_logical
        flags          = $flags
    }
    # RAM
    $ramTotal = if ($script:IsLin) { Get-LinuxMemTotalMib } else {
        try { [int]((Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).TotalPhysicalMemory / 1MB) } catch { $null }
    }
    $ram = [ordered]@{ totalMib = $ramTotal; availableMib = (Get-AvailableMemoryMib) }
    # GPU(s) - one entry for now; structured as an array for multi-GPU later.
    $gpus = @()
    if ($hw.gpu_name) {
        $gpus += [ordered]@{
            name          = $hw.gpu_name
            vendor        = $(if ($hw.gpu_name -match 'AMD|Radeon') { 'AMD' } elseif ($hw.gpu_name -match 'NVIDIA|GeForce|RTX|GTX') { 'NVIDIA' } elseif ($hw.gpu_name -match 'Intel|Arc') { 'Intel' } else { $null })
            vramTotalMib  = $hw.vram_total_mib
            kernelDriver  = $(if ($script:IsLin) { Get-LinuxKernelGpuDriver } else { $null })
            powerW        = $(if ($script:IsLin) { $p = Get-LinuxGpuPowerW; if ($p -gt 0) { $p } else { $null } } else { $null })
            vulkanDevice  = $(
                $vk = Get-VulkanDevices
                if ($vk) { $h = @($vk | Where-Object { $_.isHardware }); if ($h.Count -gt 0) { "$($h[0].name) (hardware)" } else { 'llvmpipe (software only)' } } else { $null }
            )
        }
    }
    return [ordered]@{ os = $os; cpu = $cpu; ram = $ram; gpus = $gpus }
}

function Get-DoctorInference {
    # Roll up "can this machine do GPU inference, and how".
    param($cfg, $deps, $sysinfo)
    $backendsDep = $deps | Where-Object { $_.name -eq 'llama-backends' } | Select-Object -First 1
    $vkDep       = $deps | Where-Object { $_.name -eq 'vulkan-runtime' } | Select-Object -First 1
    $gpu = if ($sysinfo.gpus.Count -gt 0) { $sysinfo.gpus[0] } else { $null }
    $backendList = if ($backendsDep -and $backendsDep.log) { $backendsDep.log } else { '' }

    $recommended = 'cpu'; $reason = 'no GPU backend available; inference runs on CPU'
    $possible = $false
    if ($gpu -and $gpu.vendor -eq 'NVIDIA' -and $backendList -match 'cuda') {
        $recommended = 'cuda'; $possible = $true; $reason = 'NVIDIA GPU + CUDA backend present'
    } elseif ($script:IsMac -and $backendList -match 'metal') {
        $recommended = 'metal'; $possible = $true; $reason = 'Apple GPU + Metal backend present'
    } elseif (($backendList -match 'vulkan' -or $backendList -match 'hip') -and $vkDep -and $vkDep.check -eq 'ok') {
        $recommended = $(if ($backendList -match 'hip') { 'hip' } else { 'vulkan' }); $possible = $true
        $reason = 'hardware Vulkan device + matching llama.cpp backend present'
    } elseif ($vkDep -and $vkDep.check -eq 'warning') {
        $reason = 'only a software Vulkan device (llvmpipe); GPU offload would be slower than CPU'
    }
    return [ordered]@{ gpuOffloadPossible = $possible; recommendedBackend = $recommended; reason = $reason }
}

function Get-DoctorReport {
    param([switch]$Extended)
    $logLines = if ($Extended) { 0 } else { 40 }
    $cfg = Get-Config
    $deps = Get-DoctorDeps -cfg $cfg -LogLines $logLines
    $sysinfo = Get-DoctorSystemInfo -cfg $cfg
    $inference = Get-DoctorInference -cfg $cfg -deps $deps -sysinfo $sysinfo

    # Roll up overall status.
    $overall = 'ok'
    foreach ($d in $deps) {
        if ($d.required -and ($d.check -eq 'fail' -or $d.check -eq 'missing')) { $overall = 'unable-to-start'; break }
    }
    if ($overall -eq 'ok') {
        foreach ($d in $deps) {
            if ($d.check -eq 'warning' -or $d.check -eq 'fail' -or ((-not $d.required) -and $d.check -eq 'missing')) { $overall = 'degraded'; break }
        }
    }

    $calibrVersion = $null
    try {
        $pkgJson = Join-Path $script:CALIBR_ROOT 'cli/package.json'
        if (Test-Path $pkgJson) { $calibrVersion = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version }
    } catch { }

    return [ordered]@{
        schemaVersion = 1
        calibrVersion = $calibrVersion
        generatedAt   = (Get-Date).ToUniversalTime().ToString('o')
        extended      = [bool]$Extended
        overallStatus = $overall
        inference     = $inference
        systemInfo    = $sysinfo
        deps          = @($deps)
    }
}

# ============================================================================
# HUMAN RENDER
# ============================================================================
function Write-DoctorHuman {
    param($report)
    $tagColor = @{ ok = 'Green'; warning = 'Yellow'; fail = 'Red'; missing = 'Red'; skipped = 'DarkGray' }
    $tagText  = @{ ok = ' OK '; warning = 'WARN'; fail = 'FAIL'; missing = 'MISS'; skipped = 'SKIP' }

    Write-Host ""
    Write-Host "=== calibr doctor ===" -ForegroundColor Cyan
    $si = $report.systemInfo
    Write-Host ("OS   : {0}  (kernel {1})" -f $si.os.name, $si.os.kernel)
    Write-Host ("CPU  : {0}  [{1}, {2}c/{3}t]" -f $si.cpu.model, $si.cpu.arch, $si.cpu.coresPhysical, $si.cpu.threadsLogical)
    Write-Host ("RAM  : {0} MiB total, {1} MiB available" -f $si.ram.totalMib, $si.ram.availableMib)
    if ($si.gpus.Count -gt 0) {
        foreach ($g in $si.gpus) {
            Write-Host ("GPU  : {0}  ({1} MiB VRAM, driver {2}, vulkan: {3})" -f $g.name, $g.vramTotalMib, $g.kernelDriver, $g.vulkanDevice)
        }
    } else {
        Write-Host "GPU  : none detected"
    }

    $ovColor = switch ($report.overallStatus) { 'ok' { 'Green' } 'degraded' { 'Yellow' } default { 'Red' } }
    Write-Host ""
    Write-Host ("Status: {0}" -f $report.overallStatus) -ForegroundColor $ovColor
    Write-Host ("Inference: GPU offload {0} -> recommended backend '{1}' ({2})" -f $(if ($report.inference.gpuOffloadPossible) { 'POSSIBLE' } else { 'NOT available' }), $report.inference.recommendedBackend, $report.inference.reason)
    Write-Host ""

    foreach ($d in $report.deps) {
        $c = if ($tagColor.ContainsKey($d.check)) { $tagColor[$d.check] } else { 'Gray' }
        $t = if ($tagText.ContainsKey($d.check))  { $tagText[$d.check] }  else { '????' }
        $line = "[{0}] {1,-22} {2}" -f $t, $d.name, $d.detail
        Write-Host $line -ForegroundColor $c
        if ($d.remediation -and ($d.check -ne 'ok' -and $d.check -ne 'skipped')) {
            Write-Host ("        fix: {0}" -f $d.remediation) -ForegroundColor DarkCyan
        }
    }
    Write-Host ""
    if ($report.overallStatus -ne 'ok') {
        Write-Host "If a problem above has no fix that resolves it, export the bundle and open an issue:" -ForegroundColor DarkGray
        Write-Host "  calibr doctor -Export -Extended" -ForegroundColor DarkGray
        Write-Host "  https://github.com/SpeederX/calibr/issues/new" -ForegroundColor DarkGray
        Write-Host ""
    }
}

# ============================================================================
# DISPATCH ENTRY
# ============================================================================
function Invoke-Doctor {
    $report = Get-DoctorReport -Extended:$Extended

    if ($Export -or $ExportPath -or $Json) {
        # Redact the whole serialized bundle (home dir, hostname) so it's safe to
        # paste into a public issue - this catches paths in `command`/`log` and
        # anywhere else, not just the fields we cap by hand.
        $json = Protect-DoctorText ($report | ConvertTo-Json -Depth 8)
        if ($Export -or $ExportPath) {
            $path = if ($ExportPath) { $ExportPath } else { Join-Path $script:CALIBR_DATA_DIR 'doctor-report.json' }
            Set-Content -LiteralPath $path -Value $json -Encoding UTF8
            if ($Json) { Write-Output $json } else { Write-Host "Doctor bundle written to: $path" -ForegroundColor Green }
        } else {
            Write-Output $json
        }
        return
    }
    Write-DoctorHuman -report $report
}
