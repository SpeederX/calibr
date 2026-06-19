# This file is dot-sourced by calibr.ps1. Keep functions script-local aware;
# command dispatch stays in the root entrypoint.

function Get-LlamaAutoFetchRoot {
    return (Join-Path $CALIBR_DATA_DIR "llama-bin")
}

function Get-ObjectField {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Find-LlamaServerUnder {
    param([string]$Root)
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return @() }
    $binName = "llama-server$script:ExeExt"
    $found = @(Get-ChildItem -LiteralPath $Root -Filter $binName -Recurse -Depth 5 -ErrorAction SilentlyContinue)
    return @($found | ForEach-Object { $_.FullName } | Select-Object -Unique)
}

function Find-LlamaServerExe {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $binName = "llama-server$script:ExeExt"   # 'llama-server.exe' on Windows, 'llama-server' elsewhere
    $onPath = Get-Command $binName -ErrorAction SilentlyContinue
    if ($onPath) { $candidates.Add($onPath.Path) }

    foreach ($f in (Find-LlamaServerUnder -Root (Get-LlamaAutoFetchRoot))) {
        $candidates.Add($f)
    }

    # Look in parent folders of ROOT up to 3 levels
    $p = $CALIBR_ROOT
    for ($i=0; $i -lt 3; $i++) {
        $p = Split-Path $p -Parent
        if (-not $p) { break }
        $found = @(Get-ChildItem $p -Filter $binName -Recurse -Depth 2 -ErrorAction SilentlyContinue)
        foreach ($f in $found) { $candidates.Add($f.FullName) }
    }
    return @($candidates | Select-Object -Unique | Where-Object { Test-Path $_ })
}

function Get-NvidiaDriverVersion {
    try {
        $line = (nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
        if ($line) { return $line.ToString().Trim() }
    } catch { }
    return ""
}

function Select-CudaVersionForDriver {
    param(
        [string]$DriverVersion,
        [string[]]$AvailableCudaVersions
    )
    $available = @($AvailableCudaVersions | Where-Object { $_ } | Sort-Object { [version]$_ } -Descending)
    if ($available.Count -eq 0) { return "" }

    $driverMajor = 0
    $m = [regex]::Match($DriverVersion, '^(\d+)')
    if ($m.Success) { $driverMajor = [int]$m.Groups[1].Value }
    if ($driverMajor -le 0) { return "" }

    $minimumDriver = @{
        "12.4" = 535
        "13.0" = 580
        "13.1" = 590
        "13.3" = 598
    }
    foreach ($v in $available) {
        $min = if ($minimumDriver.ContainsKey($v)) { [int]$minimumDriver[$v] } else { 9999 }
        if ($driverMajor -ge $min) { return $v }
    }
    return ""
}

function Get-LlamaReleasePlatformToken {
    if ($script:IsWin) { return "win" }
    if ($script:IsLin) { return "ubuntu" }
    throw "Automatic llama.cpp fetch is currently supported on Windows and Linux."
}

function Get-LlamaReleaseArchivePattern {
    if ($script:IsWin) { return '\.zip$' }
    if ($script:IsLin) { return '\.tar\.gz$' }
    throw "Automatic llama.cpp fetch is currently supported on Windows and Linux."
}

function Get-LlamaAssetCudaVersions {
    param($Assets)
    $platform = Get-LlamaReleasePlatformToken
    $ext = Get-LlamaReleaseArchivePattern
    $versions = @()
    foreach ($asset in @($Assets)) {
        $name = Get-ObjectField -Object $asset -Name "name"
        if (-not $name) { continue }
        $m = [regex]::Match($name, "^llama-.*-bin-$platform-cuda-([\d.]+)-x64$ext")
        if ($m.Success) { $versions += $m.Groups[1].Value }
    }
    return @($versions | Select-Object -Unique)
}

function Select-LlamaMainAsset {
    param(
        $Assets,
        [ValidateSet("cpu","cuda","vulkan")][string]$Flavor,
        [string]$CudaVersion = ""
    )
    $platform = Get-LlamaReleasePlatformToken
    $ext = Get-LlamaReleaseArchivePattern
    $pattern = ""
    switch ($Flavor) {
        "cpu" {
            if ($platform -eq "win") { $pattern = "^llama-.*-bin-win-cpu-x64$ext" }
            else { $pattern = "^llama-.*-bin-ubuntu-x64$ext" }
        }
        "cuda" {
            if (-not $CudaVersion) { return $null }
            $pattern = "^llama-.*-bin-$platform-cuda-$([regex]::Escape($CudaVersion))-x64$ext"
        }
        "vulkan" {
            $pattern = "^llama-.*-bin-$platform-vulkan-x64$ext"
        }
    }
    return @($Assets | Where-Object {
        $name = Get-ObjectField -Object $_ -Name "name"
        $url = Get-ObjectField -Object $_ -Name "browser_download_url"
        $name -and $url -and $name -match $pattern
    } | Select-Object -First 1)[0]
}

function Select-LlamaRuntimeAssets {
    param(
        $Assets,
        [ValidateSet("cpu","cuda","vulkan")][string]$Flavor,
        [string]$CudaVersion = ""
    )
    $out = @()
    if ($script:IsWin -and $Flavor -eq "cuda" -and $CudaVersion) {
        $pattern = "^cudart-llama-bin-win-cuda-$([regex]::Escape($CudaVersion))-x64\.zip$"
        $runtime = @($Assets | Where-Object {
            $name = Get-ObjectField -Object $_ -Name "name"
            $url = Get-ObjectField -Object $_ -Name "browser_download_url"
            $name -and $url -and $name -match $pattern
        } | Select-Object -First 1)
        if ($runtime.Count -gt 0) { $out += $runtime[0] }
    }
    return ,@($out)
}

function Select-LlamaDownloadPlan {
    param(
        $Release,
        $Hardware,
        [string]$DriverVersion = ""
    )
    $assets = @(Get-ObjectField -Object $Release -Name "assets")
    $tag = Get-ObjectField -Object $Release -Name "tag_name"
    if (-not $tag) { $tag = "latest" }

    $gpu = [string](Get-ObjectField -Object $Hardware -Name "gpu_name")
    $flavorOrder = @()
    if ($gpu -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Tesla') {
        $flavorOrder = @("cuda", "vulkan", "cpu")
    } elseif ($gpu -match 'AMD|Radeon|Intel|Arc') {
        $flavorOrder = @("vulkan", "cpu")
    } else {
        $flavorOrder = @("cpu")
    }

    foreach ($flavor in $flavorOrder) {
        $cudaVersion = ""
        if ($flavor -eq "cuda") {
            $available = @(Get-LlamaAssetCudaVersions -Assets $assets)
            if (-not $DriverVersion) { $DriverVersion = Get-NvidiaDriverVersion }
            $cudaVersion = Select-CudaVersionForDriver -DriverVersion $DriverVersion -AvailableCudaVersions $available
            if (-not $cudaVersion) { continue }
        }

        $main = Select-LlamaMainAsset -Assets $assets -Flavor $flavor -CudaVersion $cudaVersion
        if (-not $main) { continue }
        $runtime = @(Select-LlamaRuntimeAssets -Assets $assets -Flavor $flavor -CudaVersion $cudaVersion | Where-Object { $_ })
        if ($script:IsWin -and $flavor -eq "cuda" -and $runtime.Count -eq 0) { continue }

        $downloadAssets = @($main) + $runtime
        $installName = if ($flavor -eq "cuda") { "cuda-$cudaVersion" } else { $flavor }
        return [PSCustomObject]@{
            tag          = $tag
            flavor       = $flavor
            cuda_version = if ($cudaVersion) { $cudaVersion } else { $null }
            install_name = $installName
            assets       = @($downloadAssets)
        }
    }

    throw "No official llama.cpp binary asset matched this platform/GPU in release '$tag'."
}

function Get-LlamaCppRelease {
    param([string]$BuildTag = "")
    $tagOverride = if ($BuildTag) { $BuildTag } else { $env:CALIBR_LLAMA_CPP_TAG }
    if (-not $tagOverride) {
        try {
            $cfg = Get-Config
            if ($cfg.llama_cpp -and $cfg.llama_cpp.preferred_build) {
                $tagOverride = [string]$cfg.llama_cpp.preferred_build
            }
        } catch { }
    }
    if ($tagOverride) {
        if ($tagOverride -match '^\d{1,4}$') { $tagOverride = "b$tagOverride" }
        elseif ($tagOverride -notmatch '^b\d{1,4}$') { throw "LlamaCppBuild must be bNNNN (or NNNN), got '$tagOverride'." }
    }
    $url = if ($tagOverride) {
        "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$tagOverride"
    } else {
        "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
    }
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = `
            [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        return Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "calibr/0.1 (+https://github.com/SpeederX/calibr)" } -TimeoutSec 30
    } catch {
        throw "Could not resolve llama.cpp release metadata from GitHub. $($_.Exception.Message)"
    }
}

function Save-LlamaPreferredBuild {
    param([string]$BuildTag)
    if (-not $BuildTag) { return }
    $tag = $BuildTag
    if ($tag -match '^\d{1,4}$') { $tag = "b$tag" }
    if ($tag -notmatch '^b\d{1,4}$') { return }

    $localCfg = @{}
    if (Test-Path -LiteralPath $CALIBR_LOCAL_CFG) {
        try {
            $raw = Get-Content -LiteralPath $CALIBR_LOCAL_CFG -Raw | ConvertFrom-Json
            $localCfg = ConvertTo-Hashtable -obj $raw
        } catch {
            $localCfg = @{}
        }
    }
    if (-not ($localCfg["llama_cpp"] -is [hashtable])) { $localCfg["llama_cpp"] = @{} }
    $localCfg["llama_cpp"]["preferred_build"] = $tag
    $localCfg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $CALIBR_LOCAL_CFG
    Write-Host ("  Saved llama.cpp preferred build: {0}" -f $tag) -ForegroundColor Green
}

function Invoke-CalibrUrlDownload {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$DestPath,
        [long]$ExpectedBytes = 0
    )
    $destDir = Split-Path $DestPath -Parent
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

    if ((Test-Path -LiteralPath $DestPath) -and (-not $Force)) {
        $actual = (Get-Item -LiteralPath $DestPath).Length
        if ($ExpectedBytes -le 0 -or $actual -eq $ExpectedBytes) {
            Write-Host ("  [skip] already present: $DestPath ({0:N1} MB)" -f ($actual / 1MB)) -ForegroundColor DarkGray
            Write-TraceEvent -Action "llama.cpp > download archive" -Status "skipped" `
                -Message "llama.cpp > download archive skipped: archive already present" `
                -Details @{ url = $Url; path = $DestPath; bytes = $actual }
            return $true
        }
    }

    Write-Host "  [download] $Url" -ForegroundColor Cyan
    Write-Host "             -> $DestPath"
    Write-Host "[phase] downloading"
    Write-TraceEvent -Action "llama.cpp > download archive" -Status "started" `
        -Message "llama.cpp > download archive started" `
        -Details @{ url = $Url; path = $DestPath; expectedBytes = $ExpectedBytes }

    $req = $null
    $resp = $null
    $rspStream = $null
    $fileStream = $null
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = `
            [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.UserAgent = "calibr/0.1 (+https://github.com/SpeederX/calibr)"
        $req.AllowAutoRedirect = $true
        $req.Timeout = 30000
        $req.ReadWriteTimeout = 60000

        $resp = $req.GetResponse()
        $total = [long]$resp.ContentLength
        if ($total -le 0 -and $ExpectedBytes -gt 0) { $total = $ExpectedBytes }

        $rspStream = $resp.GetResponseStream()
        $fileStream = [System.IO.File]::Create($DestPath)

        $buffer = New-Object byte[] 65536
        $totalBytes = 0L
        $start = [System.Diagnostics.Stopwatch]::StartNew()
        $lastEmitMs = 0L
        $lastEmitBytes = 0L
        $inv = [System.Globalization.CultureInfo]::InvariantCulture

        while (($read = $rspStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $totalBytes += $read

            $nowMs = $start.ElapsedMilliseconds
            if (($nowMs - $lastEmitMs) -ge 200) {
                $deltaMs = $nowMs - $lastEmitMs
                $deltaBytes = $totalBytes - $lastEmitBytes
                $speed = if ($deltaMs -gt 0) { ($deltaBytes / 1048576.0) * 1000.0 / $deltaMs } else { 0.0 }
                $speedStr = $speed.ToString("F2", $inv)
                Write-Host ("[dlprog] bytes={0} total={1} speed_mibps={2} elapsed_ms={3}" -f $totalBytes, $total, $speedStr, $nowMs)
                $lastEmitMs = $nowMs
                $lastEmitBytes = $totalBytes
            }
        }

        $fileStream.Close(); $fileStream = $null
        $rspStream.Close(); $rspStream = $null
        $resp.Close(); $resp = $null

        $avgSpeed = if ($start.ElapsedMilliseconds -gt 0) {
            ($totalBytes / 1048576.0) * 1000.0 / $start.ElapsedMilliseconds
        } else { 0.0 }
        $avgStr = $avgSpeed.ToString("F2", $inv)
        Write-Host ("[dlprog] bytes={0} total={1} speed_mibps={2} elapsed_ms={3}" -f $totalBytes, $totalBytes, $avgStr, $start.ElapsedMilliseconds)
        Write-Host ("[dldone] bytes={0} elapsed_ms={1} avg_mibps={2}" -f $totalBytes, $start.ElapsedMilliseconds, $avgStr)
        Write-Host ("  [done]  {0:N1} MB in {1}s ({2} MiB/s avg)" -f ($totalBytes / 1MB), [math]::Round($start.ElapsedMilliseconds / 1000.0, 1), $avgStr) -ForegroundColor Green
        Write-TraceEvent -Action "llama.cpp > download archive" -Status "completed" `
            -Message "llama.cpp > download archive completed" `
            -Details @{ url = $Url; path = $DestPath; bytes = $totalBytes; elapsedMs = $start.ElapsedMilliseconds; avgMibps = $avgStr }
        return $true
    } catch {
        Write-Host ("  [FAIL]  {0}" -f $_.Exception.Message) -ForegroundColor Red
        Write-TraceEvent -Action "llama.cpp > download archive" -Status "failed" `
            -Message "llama.cpp > download archive failed" `
            -Details @{ url = $Url; path = $DestPath; error = $_.Exception.Message }
        if ($fileStream) { try { $fileStream.Close() } catch {} }
        if ((Test-Path -LiteralPath $DestPath) -and (Get-Item -LiteralPath $DestPath).Length -eq 0) {
            Remove-Item -LiteralPath $DestPath -Force -ErrorAction SilentlyContinue
        }
        return $false
    } finally {
        if ($fileStream) { try { $fileStream.Dispose() } catch {} }
        if ($rspStream)  { try { $rspStream.Dispose() }  catch {} }
        if ($resp)       { try { $resp.Close() }         catch {} }
    }
}

function Expand-LlamaArchive {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$Destination
    )
    if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
    Write-Host "  [extract] $ArchivePath" -ForegroundColor Cyan
    if ($ArchivePath -match '\.zip$') {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
        return
    }
    if ($ArchivePath -match '\.tar\.gz$') {
        $tar = Get-Command tar -ErrorAction SilentlyContinue
        if (-not $tar) { throw "tar is required to extract $ArchivePath." }
        & $tar.Path -xzf $ArchivePath -C $Destination
        if ($LASTEXITCODE -ne 0) { throw "tar failed while extracting $ArchivePath." }
        return
    }
    throw "Unsupported llama.cpp archive format: $ArchivePath"
}

function Invoke-AutoFetchLlama {
    param($Hardware)

    $root = Get-LlamaAutoFetchRoot
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }

    $requestedBuild = $LlamaCppBuild
    if (-not $requestedBuild) {
        try {
            $cfg = Get-Config
            if ($cfg.llama_cpp -and $cfg.llama_cpp.preferred_build) {
                $requestedBuild = [string]$cfg.llama_cpp.preferred_build
            }
        } catch { }
    }
    if ($requestedBuild -match '^\d{1,4}$') { $requestedBuild = "b$requestedBuild" }

    if (-not $Force) {
        if ($requestedBuild -and $requestedBuild -match '^b\d{1,4}$') {
            $pinnedRoot = Join-Path $root $requestedBuild
            $existingPinned = @(Find-LlamaServerUnder -Root $pinnedRoot)
            if ($existingPinned.Count -gt 0) {
                Write-Host "  Found pinned llama.cpp ${requestedBuild}: $($existingPinned[0])" -ForegroundColor Green
                if ($LlamaCppBuild) { Save-LlamaPreferredBuild -BuildTag $LlamaCppBuild }
                return $existingPinned[0]
            }
        } else {
            $existing = @(Find-LlamaServerUnder -Root $root)
            if ($existing.Count -gt 0) {
                Write-Host "  Found previously fetched llama-server: $($existing[0])" -ForegroundColor Green
                return $existing[0]
            }
        }
    }

    Write-Host "  Resolving latest llama.cpp release from GitHub..." -ForegroundColor Cyan
    Write-TraceEvent -Action "llama.cpp > resolve release" -Status "started" `
        -Message "llama.cpp > resolve release started" `
        -Details @{ requestedBuild = $LlamaCppBuild }
    try {
        $release = Get-LlamaCppRelease -BuildTag $LlamaCppBuild
        Write-TraceEvent -Action "llama.cpp > resolve release" -Status "completed" `
            -Message "llama.cpp > resolve release completed" `
            -Details @{ requestedBuild = $LlamaCppBuild; resolvedTag = $release.tag_name }
    } catch {
        Write-TraceEvent -Action "llama.cpp > resolve release" -Status "failed" `
            -Message "llama.cpp > resolve release failed" `
            -Details @{ requestedBuild = $LlamaCppBuild; error = $_.Exception.Message }
        throw
    }
    $driver = Get-NvidiaDriverVersion
    $plan = Select-LlamaDownloadPlan -Release $release -Hardware $Hardware -DriverVersion $driver

    $installDir = Join-Path (Join-Path $root $plan.tag) $plan.install_name
    if (-not $Force) {
        $installed = @(Find-LlamaServerUnder -Root $installDir)
        if ($installed.Count -gt 0) {
            Write-Host "  Found llama-server in $installDir" -ForegroundColor Green
            return $installed[0]
        }
    }

    $label = if ($plan.cuda_version) { "$($plan.flavor) $($plan.cuda_version)" } else { $plan.flavor }
    Write-Host ("  Selected llama.cpp {0} ({1})" -f $plan.tag, $label) -ForegroundColor Green
    Write-TraceEvent -Action "llama.cpp > select build" -Status "completed" `
        -Message ("llama.cpp > select build completed: {0} ({1})" -f $plan.tag, $label) `
        -Details @{ tag = $plan.tag; flavor = $plan.flavor; cudaVersion = $plan.cuda_version; installName = $plan.install_name }

    $archivesDir = Join-Path $root "archives"
    foreach ($assetGroup in @($plan.assets)) {
        foreach ($asset in @($assetGroup | Where-Object { $_ })) {
            $name = Get-ObjectField -Object $asset -Name "name"
            $url = Get-ObjectField -Object $asset -Name "browser_download_url"
            $size = [long](Get-ObjectField -Object $asset -Name "size")
            if (-not $name -or -not $url) { throw "Malformed llama.cpp release asset." }
            $archivePath = Join-Path $archivesDir $name
            $ok = Invoke-CalibrUrlDownload -Url $url -DestPath $archivePath -ExpectedBytes $size
            if (-not $ok) { throw "Download failed for $name." }
        Write-TraceEvent -Action "llama.cpp > extract archive" -Status "started" `
            -Message "llama.cpp > extract archive started" `
            -Details @{ archive = $archivePath; destination = $installDir }
        try {
            Expand-LlamaArchive -ArchivePath $archivePath -Destination $installDir
            Write-TraceEvent -Action "llama.cpp > extract archive" -Status "completed" `
                -Message "llama.cpp > extract archive completed" `
                -Details @{ archive = $archivePath; destination = $installDir }
        } catch {
            Write-TraceEvent -Action "llama.cpp > extract archive" -Status "failed" `
                -Message "llama.cpp > extract archive failed" `
                -Details @{ archive = $archivePath; destination = $installDir; error = $_.Exception.Message }
            throw
        }
        }
    }

    $server = @(Find-LlamaServerUnder -Root $installDir | Select-Object -First 1)
    if ($server.Count -eq 0) { throw "Downloaded llama.cpp, but llama-server$script:ExeExt was not found in $installDir." }
    if ($LlamaCppBuild) { Save-LlamaPreferredBuild -BuildTag $LlamaCppBuild }
    return $server[0]
}

function Get-LlamaServerVersion {
    # Probe `llama-server --version` for the build tag (e.g. "b9360").
    # Falls back to extracting `bNNNN` from the binary path before returning
    # "unknown". Cheap one-off invocation (no model load); used by
    # Initialize-BenchSession to stamp the version on every result so the
    # report can group by llama.cpp build and the cache can re-run failures
    # that were recorded against a different version.
    param([string]$Exe)
    if (-not $Exe -or -not (Test-Path $Exe)) { return $null }
    try {
        $out = & $Exe --version 2>&1 | Out-String
        # Current llama-server (b9482+) prints "version: 9482 (4fb16eccc)" -
        # first number is the build, parenthesized is a commit hash we don't
        # want. Older builds occasionally printed "(b9460)" directly; match
        # both shapes, preferring the explicit bNNNN form.
        $m = [regex]::Match($out, '\((b\d{4,})\)')
        if ($m.Success) { return $m.Groups[1].Value }
        $m2 = [regex]::Match($out, 'version:\s*(\d{4,})\b')
        if ($m2.Success) { return 'b' + $m2.Groups[1].Value }
    } catch { }
    # Path-based fallback: the official zip names embed the build tag.
    $pm = [regex]::Match($Exe, '(b\d{4,})')
    if ($pm.Success) { return $pm.Groups[1].Value }
    return 'unknown'
}

function Initialize-BenchSession {
    # Set $script:BENCH_* and $script:LLAMA_SERVER_VERSION once per outer
    # command invocation. `all` calls Invoke-Bench in a loop (one per
    # sample); each inner call should share the same session, so this
    # helper is idempotent: a second call within the same process is a
    # no-op. The fields end up stamped on every result JSON so the report
    # can answer "show me only the results from THIS session" and "did
    # this model start working when I upgraded llama?".
    param([string]$LlamaServerExe)
    if ($script:BENCH_SESSION_ID) { return }
    $script:BENCH_SESSION_ID = [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $script:BENCH_SESSION_STARTED_AT = (Get-Date).ToUniversalTime().ToString('o')
    $script:LLAMA_SERVER_VERSION = Get-LlamaServerVersion -Exe $LlamaServerExe
    if (-not $script:LLAMA_SERVER_VERSION) { $script:LLAMA_SERVER_VERSION = 'unknown' }
}

# ============================================================================
# BACKEND DETECTION (CUDA / Vulkan / Metal / HIP / SYCL / CPU)
# ============================================================================
function Get-LlamaBackends {
    # Inspect ggml-*.dll siblings of llama-server.exe to learn which compute
    # backends the build supports. Cheap (single dir listing), no process probe.
    param([string]$exe)
    $backends = @{ cuda=$false; vulkan=$false; metal=$false; hip=$false; sycl=$false; cpu=$false }
    if (-not $exe -or -not (Test-Path $exe)) { return $backends }
    $dir = Split-Path $exe -Parent
    # Match ggml-cuda.dll (Windows) and libggml-cuda.so / ggml-cuda.so (Linux);
    # the leading '*' tolerates the 'lib' prefix Linux shared objects carry.
    $dlls = @(Get-ChildItem $dir -Filter "*ggml-*.$script:LibExt" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    foreach ($d in $dlls) {
        if ($d -match 'ggml-cuda')   { $backends.cuda   = $true }
        if ($d -match 'ggml-vulkan') { $backends.vulkan = $true }
        if ($d -match 'ggml-metal')  { $backends.metal  = $true }
        if ($d -match 'ggml-hip')    { $backends.hip    = $true }
        if ($d -match 'ggml-sycl')   { $backends.sycl   = $true }
        if ($d -match 'ggml-cpu')    { $backends.cpu    = $true }
    }
    return $backends
}

function Test-BackendHealthy {
    # Cross-check the detected GPU against the available llama.cpp backends.
    # Returns an array of warning strings (empty if optimal).
    param($cfg, $backends)
    $warnings = @()
    $gpu = $cfg.hardware.gpu_name
    if ($gpu -and $gpu -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Tesla') {
        if (-not $backends.cuda) {
            $msg = "NVIDIA GPU '$gpu' detected but llama.cpp build has NO CUDA backend. "
            if ($backends.vulkan) {
                $msg += "Vulkan will be used; expect ~10-15% slower inference. "
            } else {
                $msg += "Only CPU is available; inference will be very slow. "
            }
            $msg += "Get a CUDA build: https://github.com/ggml-org/llama.cpp/releases"
            $warnings += $msg
        }
    } elseif ($gpu -and $gpu -match 'AMD|Radeon') {
        if (-not ($backends.hip -or $backends.vulkan)) {
            $warnings += "AMD GPU '$gpu' detected but no HIP/Vulkan backend available; CPU only."
        }
    } elseif ($gpu -and $gpu -match 'Intel|Arc') {
        if (-not ($backends.sycl -or $backends.vulkan)) {
            $warnings += "Intel GPU '$gpu' detected but no SYCL/Vulkan backend available; CPU only."
        }
    } else {
        if (-not ($backends.cuda -or $backends.vulkan -or $backends.hip -or $backends.metal -or $backends.sycl)) {
            $warnings += "No GPU backend available in llama.cpp build; CPU only."
        }
    }
    return $warnings
}


