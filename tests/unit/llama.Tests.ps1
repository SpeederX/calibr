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

Describe "llama.cpp auto-fetch execution" {
    It "downloads and extracts a stub llama.cpp build into CALIBR_DATA_DIR" {
        With-TestPlatform -Win $true -Lin $false -Body {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-llama-stub-" + [guid]::NewGuid())
            $oldData = $script:CALIBR_DATA_DIR
            $oldCfg = $script:CALIBR_LOCAL_CFG
            $oldForce = $script:Force
            $oldBuild = $script:LlamaCppBuild
            $oldRelease = (Get-Command Get-LlamaCppRelease -CommandType Function).ScriptBlock
            $oldDriver = (Get-Command Get-NvidiaDriverVersion -CommandType Function).ScriptBlock
            $oldDownload = (Get-Command Invoke-CalibrUrlDownload -CommandType Function).ScriptBlock
            $oldExpand = (Get-Command Expand-LlamaArchive -CommandType Function).ScriptBlock
            try {
                $script:CALIBR_DATA_DIR = $tmp
                $script:CALIBR_LOCAL_CFG = Join-Path $tmp "config.json"
                $script:Force = $false
                $script:LlamaCppBuild = "9360"
                $script:LLAMA_STUB_DOWNLOADS = @()
                $script:LLAMA_STUB_EXTRACTS = @()
                $script:LLAMA_STUB_RELEASE = [PSCustomObject]@{
                    tag_name = "b9360"
                    assets = @(
                        New-TestAsset "llama-b9360-bin-win-cuda-13.1-x64.zip" 123
                        New-TestAsset "cudart-llama-bin-win-cuda-13.1-x64.zip" 456
                    )
                }

                Set-Item -Path Function:\Get-LlamaCppRelease -Value {
                    param([string]$BuildTag = "")
                    $script:LLAMA_STUB_BUILD_TAG = $BuildTag
                    return $script:LLAMA_STUB_RELEASE
                }
                Set-Item -Path Function:\Get-NvidiaDriverVersion -Value { return "596.21" }
                Set-Item -Path Function:\Invoke-CalibrUrlDownload -Value {
                    param([string]$Url, [string]$DestPath, [long]$ExpectedBytes = 0)
                    $script:LLAMA_STUB_DOWNLOADS += $Url
                    $dir = Split-Path $DestPath -Parent
                    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                    Set-Content -LiteralPath $DestPath -Value "stub archive"
                    return $true
                }
                Set-Item -Path Function:\Expand-LlamaArchive -Value {
                    param([string]$ArchivePath, [string]$Destination)
                    $script:LLAMA_STUB_EXTRACTS += $ArchivePath
                    if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
                    New-Item -ItemType File -Path (Join-Path $Destination "llama-server.exe") -Force | Out-Null
                }

                $server = Invoke-AutoFetchLlama -Hardware @{ gpu_name = "NVIDIA GeForce RTX 2070" }
                $expectedServer = Join-Path (Join-Path (Join-Path $tmp "llama-bin") "b9360") "cuda-13.1\llama-server.exe"
                Assert-Equal $expectedServer $server
                Assert-True (Test-Path -LiteralPath $server) "stub llama-server should be extracted"
                Assert-Equal 2 @($script:LLAMA_STUB_DOWNLOADS).Count
                Assert-True (@($script:LLAMA_STUB_DOWNLOADS) -contains "https://example.invalid/llama-b9360-bin-win-cuda-13.1-x64.zip")
                Assert-True (@($script:LLAMA_STUB_DOWNLOADS) -contains "https://example.invalid/cudart-llama-bin-win-cuda-13.1-x64.zip")
                Assert-Equal 2 @($script:LLAMA_STUB_EXTRACTS).Count
                Assert-True (@(Find-LlamaServerExe) -contains $server) "stub server should be discoverable after fetch"
                Assert-Equal "9360" $script:LLAMA_STUB_BUILD_TAG "typed build should be passed to release lookup"
                $saved = Get-Content -LiteralPath $script:CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
                Assert-Equal "b9360" $saved.llama_cpp.preferred_build "typed build should be saved as config-level pin"
            } finally {
                Set-Item -Path Function:\Get-LlamaCppRelease -Value $oldRelease
                Set-Item -Path Function:\Get-NvidiaDriverVersion -Value $oldDriver
                Set-Item -Path Function:\Invoke-CalibrUrlDownload -Value $oldDownload
                Set-Item -Path Function:\Expand-LlamaArchive -Value $oldExpand
                $script:CALIBR_DATA_DIR = $oldData
                $script:CALIBR_LOCAL_CFG = $oldCfg
                $script:Force = $oldForce
                $script:LlamaCppBuild = $oldBuild
                Remove-Variable -Name LLAMA_STUB_DOWNLOADS -Scope Script -ErrorAction SilentlyContinue
                Remove-Variable -Name LLAMA_STUB_EXTRACTS -Scope Script -ErrorAction SilentlyContinue
                Remove-Variable -Name LLAMA_STUB_RELEASE -Scope Script -ErrorAction SilentlyContinue
                Remove-Variable -Name LLAMA_STUB_BUILD_TAG -Scope Script -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    }

    It "uses the configured pinned llama.cpp build before other cached builds" {
        With-TestPlatform -Win $true -Lin $false -Body {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-llama-pin-" + [guid]::NewGuid())
            $oldData = $script:CALIBR_DATA_DIR
            $oldCfg = $script:CALIBR_LOCAL_CFG
            $oldForce = $script:Force
            $oldBuild = $script:LlamaCppBuild
            $oldRelease = (Get-Command Get-LlamaCppRelease -CommandType Function).ScriptBlock
            try {
                $script:CALIBR_DATA_DIR = $tmp
                $script:CALIBR_LOCAL_CFG = Join-Path $tmp "config.json"
                $script:Force = $false
                $script:LlamaCppBuild = ""

                foreach ($tag in @("b1111", "b2222")) {
                    $serverDir = Join-Path (Join-Path (Join-Path $tmp "llama-bin") $tag) "cpu"
                    New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
                    New-Item -ItemType File -Path (Join-Path $serverDir "llama-server.exe") -Force | Out-Null
                }
                @{ llama_cpp = @{ preferred_build = "b2222" } } |
                    ConvertTo-Json -Depth 5 |
                    Out-File -Encoding utf8 $script:CALIBR_LOCAL_CFG

                Set-Item -Path Function:\Get-LlamaCppRelease -Value { throw "release lookup should not run when pinned cache exists" }

                $server = Invoke-AutoFetchLlama -Hardware @{ gpu_name = "CPU" }
                Assert-True ($server -like "*b2222*") "pinned cached build should win over older cache entries"
            } finally {
                Set-Item -Path Function:\Get-LlamaCppRelease -Value $oldRelease
                $script:CALIBR_DATA_DIR = $oldData
                $script:CALIBR_LOCAL_CFG = $oldCfg
                $script:Force = $oldForce
                $script:LlamaCppBuild = $oldBuild
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}

Exit-WithResults
