# Unit tests for the doctor module's pure parsers.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "ConvertFrom-UeventDriver" {
    It "extracts the DRIVER= value" {
        $t = "DRIVER=amdgpu`nPCI_CLASS=30000`nMODALIAS=pci:v00001002"
        Assert-Equal 'amdgpu' (ConvertFrom-UeventDriver $t)
    }
    It "returns null when there is no DRIVER line" {
        Assert-Equal $null (ConvertFrom-UeventDriver "PCI_CLASS=30000`nFOO=bar")
    }
    It "returns null on empty input" {
        Assert-Equal $null (ConvertFrom-UeventDriver "")
    }
    It "reads the legacy radeon driver" {
        Assert-Equal 'radeon' (ConvertFrom-UeventDriver "DRIVER=radeon")
    }
}

Describe "ConvertFrom-CpuinfoFlags" {
    # A trimmed flags line from the Mullins dev box: AVX present, AVX2/FMA/BMI2 absent.
    $line = "flags : fpu vme de pse tsc msr pae mce sse sse2 avx bmi1 f16c sse4_2 sse4_1"

    It "marks present flags true" {
        $f = ConvertFrom-CpuinfoFlags $line
        Assert-True $f['avx']
        Assert-True $f['bmi1']
        Assert-True $f['f16c']
        Assert-True $f['sse4_2']
    }
    It "marks absent flags false (the SIGILL trio)" {
        $f = ConvertFrom-CpuinfoFlags $line
        Assert-False $f['avx2']
        Assert-False $f['fma']
        Assert-False $f['bmi2']
    }
    It "detects the full modern set when present" {
        $f = ConvertFrom-CpuinfoFlags "flags : avx avx2 fma bmi1 bmi2 f16c"
        Assert-True $f['avx2']
        Assert-True $f['fma']
        Assert-True $f['bmi2']
    }
    It "returns all-false when there is no flags line" {
        $f = ConvertFrom-CpuinfoFlags "model name : Some CPU"
        Assert-False $f['avx']
        Assert-False $f['avx2']
    }
    It "does not partial-match (avx must not satisfy avx2)" {
        $f = ConvertFrom-CpuinfoFlags "flags : avx"
        Assert-True  $f['avx']
        Assert-False $f['avx2']
    }
}

Describe "ConvertFrom-VulkanSummary" {
    # Two-device --summary: a hardware RADV iGPU and the llvmpipe software fallback.
    $txt = @"
Devices:
========
GPU0:
        apiVersion         = 1.3.296
        deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
        deviceName         = AMD Radeon R5 Graphics (RADV KABINI)
        driverName         = radv
GPU1:
        apiVersion         = 1.3.296
        deviceType         = PHYSICAL_DEVICE_TYPE_CPU
        deviceName         = llvmpipe (LLVM 20.1.2, 256 bits)
        driverName         = llvmpipe
"@

    It "parses both devices" {
        $d = ConvertFrom-VulkanSummary $txt
        Assert-Equal 2 $d.Count
    }
    It "flags the RADV device as hardware" {
        $d = ConvertFrom-VulkanSummary $txt
        $radv = $d | Where-Object { $_.name -match 'RADV' } | Select-Object -First 1
        Assert-True $radv.isHardware
    }
    It "flags llvmpipe (CPU type) as not hardware" {
        $d = ConvertFrom-VulkanSummary $txt
        $sw = $d | Where-Object { $_.name -match 'llvmpipe' } | Select-Object -First 1
        Assert-False $sw.isHardware
    }
    It "returns an empty array for empty input" {
        $d = ConvertFrom-VulkanSummary ""
        Assert-Equal 0 $d.Count
    }
    It "treats a software-only system as having no hardware device" {
        $sw = @"
GPU0:
        deviceType         = PHYSICAL_DEVICE_TYPE_CPU
        deviceName         = llvmpipe (LLVM 20.1.2, 256 bits)
"@
        $d = ConvertFrom-VulkanSummary $sw
        $hw = @($d | Where-Object { $_.isHardware })
        Assert-Equal 0 $hw.Count
    }
}

Describe "ConvertFrom-OsRelease" {
    It "parses quoted NAME and VERSION_ID" {
        $t = "PRETTY_NAME=`"Ubuntu 24.04 LTS`"`nNAME=`"Ubuntu`"`nVERSION_ID=`"24.04`""
        $o = ConvertFrom-OsRelease $t
        Assert-Equal 'Ubuntu' $o.name
        Assert-Equal '24.04'  $o.versionId
    }
    It "parses unquoted values" {
        $o = ConvertFrom-OsRelease "NAME=Fedora`nVERSION_ID=40"
        Assert-Equal 'Fedora' $o.name
        Assert-Equal '40'     $o.versionId
    }
    It "returns nulls when fields are absent" {
        $o = ConvertFrom-OsRelease "ID=arch"
        Assert-Equal $null $o.name
        Assert-Equal $null $o.versionId
    }
}

Exit-WithResults
