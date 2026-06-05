# Unit tests for llama.cpp discovery and auto-fetch planning.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

function New-TestAsset {
    param([string]$Name, [long]$Size = 1000)
    return [PSCustomObject]@{
        name = $Name
        browser_download_url = "https://example.invalid/$Name"
        size = $Size
    }
}

function With-TestPlatform {
    param(
        [bool]$Win,
        [bool]$Lin,
        [scriptblock]$Body
    )
    $oldWin = $script:IsWin
    $oldLin = $script:IsLin
    $oldMac = $script:IsMac
    $oldExe = $script:ExeExt
    $oldLib = $script:LibExt
    try {
        $script:IsWin = $Win
        $script:IsLin = $Lin
        $script:IsMac = -not ($Win -or $Lin)
        $script:ExeExt = if ($Win) { ".exe" } else { "" }
        $script:LibExt = if ($Win) { "dll" } else { "so" }
        & $Body
    } finally {
        $script:IsWin = $oldWin
        $script:IsLin = $oldLin
        $script:IsMac = $oldMac
        $script:ExeExt = $oldExe
        $script:LibExt = $oldLib
    }
}

Describe "llama.cpp auto-fetch planning" {
    It "picks the highest CUDA build compatible with the NVIDIA driver" {
        $available = @("12.4", "13.0", "13.1", "13.3")
        Assert-Equal "12.4" (Select-CudaVersionForDriver -DriverVersion "536.23" -AvailableCudaVersions $available)
        Assert-Equal "13.0" (Select-CudaVersionForDriver -DriverVersion "580.12" -AvailableCudaVersions $available)
        Assert-Equal "13.1" (Select-CudaVersionForDriver -DriverVersion "596.21" -AvailableCudaVersions $available)
        Assert-Equal "13.3" (Select-CudaVersionForDriver -DriverVersion "598.00" -AvailableCudaVersions $available)
    }

    It "selects Windows CUDA plus cudart for NVIDIA when compatible" {
        With-TestPlatform -Win $true -Lin $false -Body {
            $release = [PSCustomObject]@{
                tag_name = "b9360"
                assets = @(
                    New-TestAsset "llama-b9360-bin-win-cuda-12.4-x64.zip"
                    New-TestAsset "llama-b9360-bin-win-cuda-13.1-x64.zip"
                    New-TestAsset "cudart-llama-bin-win-cuda-13.1-x64.zip"
                    New-TestAsset "llama-b9360-bin-win-vulkan-x64.zip"
                    New-TestAsset "llama-b9360-bin-win-cpu-x64.zip"
                )
            }
            $plan = Select-LlamaDownloadPlan -Release $release -Hardware @{ gpu_name = "NVIDIA GeForce RTX 2070" } -DriverVersion "596.21"
            Assert-Equal "cuda" $plan.flavor
            Assert-Equal "13.1" $plan.cuda_version
            Assert-Equal "cuda-13.1" $plan.install_name
            Assert-Equal 2 @($plan.assets).Count
            Assert-True (@($plan.assets | ForEach-Object { $_.name }) -contains "cudart-llama-bin-win-cuda-13.1-x64.zip")
        }
    }

    It "falls back to Vulkan when NVIDIA CUDA is not compatible" {
        With-TestPlatform -Win $true -Lin $false -Body {
            $release = [PSCustomObject]@{
                tag_name = "b9360"
                assets = @(
                    New-TestAsset "llama-b9360-bin-win-cuda-13.1-x64.zip"
                    New-TestAsset "cudart-llama-bin-win-cuda-13.1-x64.zip"
                    New-TestAsset "llama-b9360-bin-win-vulkan-x64.zip"
                    New-TestAsset "llama-b9360-bin-win-cpu-x64.zip"
                )
            }
            $plan = Select-LlamaDownloadPlan -Release $release -Hardware @{ gpu_name = "NVIDIA GeForce GTX 1080" } -DriverVersion "531.00"
            Assert-Equal "vulkan" $plan.flavor
            Assert-Equal "vulkan" $plan.install_name
            Assert-Equal 1 @($plan.assets).Count
        }
    }

    It "selects Linux Vulkan for AMD/Intel-class GPUs" {
        With-TestPlatform -Win $false -Lin $true -Body {
            $release = [PSCustomObject]@{
                tag_name = "b9360"
                assets = @(
                    New-TestAsset "llama-b9360-bin-ubuntu-vulkan-x64.tar.gz"
                    New-TestAsset "llama-b9360-bin-ubuntu-x64.tar.gz"
                )
            }
            $plan = Select-LlamaDownloadPlan -Release $release -Hardware @{ gpu_name = "AMD Radeon RX 7800 XT" }
            Assert-Equal "vulkan" $plan.flavor
            Assert-Equal "vulkan" $plan.install_name
            Assert-Equal "llama-b9360-bin-ubuntu-vulkan-x64.tar.gz" @($plan.assets)[0].name
        }
    }
}

Describe "llama.cpp auto-fetch discovery" {
    It "includes previously auto-fetched llama-server under CALIBR_DATA_DIR" {
        $oldData = $script:CALIBR_DATA_DIR
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-llama-find-" + [guid]::NewGuid())
        try {
            $script:CALIBR_DATA_DIR = $tmp
            $serverDir = Join-Path (Join-Path (Join-Path $tmp "llama-bin") "b9360") "cpu"
            New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
            $server = Join-Path $serverDir ("llama-server$script:ExeExt")
            New-Item -ItemType File -Path $server -Force | Out-Null

            $found = @(Find-LlamaServerExe)
            Assert-True ($found -contains $server) "auto-fetched server path should be discoverable"
        } finally {
            $script:CALIBR_DATA_DIR = $oldData
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

Exit-WithResults
