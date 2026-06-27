# Unit tests for the matching engine module.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Download manifest helpers" {
    # All tests in this block redirect CALIBR_DOWNLOADS to a temp file so we
    # don't touch the real data dir, then restore on each It (a fresh temp
    # file per assertion keeps state isolated).
    $script:_origDownloads = $script:CALIBR_DOWNLOADS

    function _newTempDownloads {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-test-downloads-{0}.json" -f ([guid]::NewGuid()))
        $script:CALIBR_DOWNLOADS = $tmp
        return $tmp
    }

    It "Get-DownloadManifest returns nothing usable when file missing" {
        $tmp = _newTempDownloads
        $m = @(Get-DownloadManifest)
        Assert-Equal 0 $m.Count
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Add-DownloadManifestEntry persists a new entry" {
        $tmp = _newTempDownloads
        Add-DownloadManifestEntry -CatalogId "qwen3.5-9b-q4km" -Model "Qwen3.5-9B" -ModelPath "C:\models\Q\Qwen3.5-9B-Q4_K_M.gguf" -SizeBytes 5627040640
        $m = @(Get-DownloadManifest)
        Assert-Equal 1 $m.Count
        Assert-Equal "qwen3.5-9b-q4km" $m[0].catalog_id
        Assert-Equal "Qwen3.5-9B" $m[0].model
        Assert-Equal 5627040640 $m[0].size_bytes
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Add-DownloadManifestEntry is idempotent on model_path (replaces, not duplicates)" {
        $tmp = _newTempDownloads
        Add-DownloadManifestEntry -CatalogId "g-e2b" -Model "Gemma-4-E2B" -ModelPath "C:\models\G\E2B.gguf" -SizeBytes 100
        Start-Sleep -Milliseconds 10  # ensure a distinct timestamp
        Add-DownloadManifestEntry -CatalogId "g-e2b" -Model "Gemma-4-E2B" -ModelPath "C:\models\G\E2B.gguf" -SizeBytes 200
        $m = @(Get-DownloadManifest)
        Assert-Equal 1 $m.Count
        Assert-Equal 200 $m[0].size_bytes  "newer entry's size_bytes should win"
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Remove-DownloadManifestEntry drops only the matching model_path" {
        $tmp = _newTempDownloads
        Add-DownloadManifestEntry -CatalogId "a" -Model "A" -ModelPath "C:\models\A.gguf"
        Add-DownloadManifestEntry -CatalogId "b" -Model "B" -ModelPath "C:\models\B.gguf"
        Remove-DownloadManifestEntry -ModelPath "c:\models\a.gguf"
        $m = @(Get-DownloadManifest)
        Assert-Equal 1 $m.Count
        Assert-Equal "C:\models\B.gguf" $m[0].model_path
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Test-DownloadedByCalibr returns true for tracked paths and false otherwise" {
        $tmp = _newTempDownloads
        Add-DownloadManifestEntry -CatalogId "x" -Model "X" -ModelPath "D:\mine\foo.gguf"
        Assert-True  (Test-DownloadedByCalibr -Path "D:\mine\foo.gguf")
        Assert-False (Test-DownloadedByCalibr -Path "D:\mine\bar.gguf")
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Test-DownloadedByCalibr is case-insensitive (Windows filesystem semantics)" {
        $tmp = _newTempDownloads
        Add-DownloadManifestEntry -CatalogId "x" -Model "X" -ModelPath "D:\Mine\Foo.gguf"
        Assert-True (Test-DownloadedByCalibr -Path "d:\mine\foo.gguf")
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    It "Get-DownloadManifest treats corrupt JSON as empty without throwing" {
        $tmp = _newTempDownloads
        "{ not valid json" | Out-File -Encoding utf8 $tmp
        $m = @(Get-DownloadManifest)
        Assert-Equal 0 $m.Count
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    }

    # Restore the real path so a subsequent test file or interactive session
    # sees the unmocked state.
    $script:CALIBR_DOWNLOADS = $script:_origDownloads
}


Describe "Select-CatalogByPreset" {
    function _catalog {
        return @(
            @{ id = "qwen-mini";  model = "Qwen-Mini" }
            @{ id = "qwen-9b";    model = "Qwen-9B" }
            @{ id = "gemma-2b";   model = "Gemma-2B" }
            @{ id = "gemma-31b";  model = "Gemma-31B" }
        )
    }
    It "returns the full catalog when preset is \$null" {
        $r = Select-CatalogByPreset -catalog (_catalog) -preset $null
        Assert-Equal 4 $r.Count
    }
    It "returns the full catalog when preset.models is '*'" {
        $p = @{ models = '*' }
        $r = Select-CatalogByPreset -catalog (_catalog) -preset $p
        Assert-Equal 4 $r.Count
    }
    It "filters to the listed ids when preset.models is an array" {
        $p = @{ models = @('qwen-mini', 'gemma-2b') }
        $r = Select-CatalogByPreset -catalog (_catalog) -preset $p
        Assert-Equal 2 $r.Count
        Assert-True (@($r | ForEach-Object { $_.id }) -contains 'qwen-mini')
        Assert-True (@($r | ForEach-Object { $_.id }) -contains 'gemma-2b')
    }
    It "returns empty when no preset.models id matches the catalog" {
        $p = @{ models = @('nope') }
        $r = Select-CatalogByPreset -catalog (_catalog) -preset $p
        Assert-Equal 0 $r.Count
    }
}

Describe "Select-ModelCatalog" {
    function _filterCatalog {
        return @(
            @{ id = "qwen-mini"; model = "Qwen-Mini" }
            @{ id = "qwen-9b"; model = "Qwen-9B" }
            @{ id = "gemma-2b"; model = "Gemma-2B" }
        )
    }

    It "combines preset, wildcard ids and model regex in one filter" {
        $preset = @{ models = @("qwen-mini", "qwen-9b", "gemma-2b") }
        $result = @(Select-ModelCatalog `
            -Catalog (_filterCatalog) `
            -Preset $preset `
            -CatalogId "qwen*" `
            -ModelRegex "9B")

        Assert-Equal 1 $result.Count
        Assert-Equal "qwen-9b" $result[0].id
    }

    It "accepts comma-separated catalog ids" {
        $result = @(Select-ModelCatalog -Catalog (_filterCatalog) -CatalogId "qwen-mini,gemma*")
        Assert-Equal 2 $result.Count
    }
}

Describe "Download destination" {
    It "falls back to CALIBR_DATA_DIR downloaded-models, not CALIBR_ROOT" {
        $cfg = @{ scan_paths = @() }
        $sample = @{ target_dir = "Qwen/Fake" }
        $oldDestination = $script:Destination
        try {
            $script:Destination = ""
            $dest = Get-DownloadDestination -sample $sample -cfg $cfg
            $expected = Join-Path $CALIBR_DOWNLOADED_MODELS_DIR "Qwen/Fake"
            Assert-Equal $expected $dest
        } finally {
            $script:Destination = $oldDestination
        }
    }
}

Describe "Node download wiring" {
    It "Resolve-TsModelDownloadScript finds the local cli/dist downloader" {
        $oldRoot = $script:CALIBR_ROOT
        $oldFlag = $env:CALIBR_TS_MODEL_DOWNLOAD
        $oldScript = $env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT
        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-dl-resolver-{0}" -f [guid]::NewGuid().ToString('N'))
        $runner = Join-Path $tmpRoot "cli\dist\engine\catalog\modelDownloadCli.js"
        New-Item -ItemType Directory -Path (Split-Path $runner -Parent) -Force | Out-Null
        Set-Content -LiteralPath $runner -Value "stub" -Encoding UTF8
        try {
            $script:CALIBR_ROOT = $tmpRoot
            $env:CALIBR_TS_MODEL_DOWNLOAD = $null
            $env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT = $null
            Assert-Equal $runner (Resolve-TsModelDownloadScript)
        } finally {
            $script:CALIBR_ROOT = $oldRoot
            $env:CALIBR_TS_MODEL_DOWNLOAD = $oldFlag
            $env:CALIBR_TS_MODEL_DOWNLOAD_SCRIPT = $oldScript
            Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "Invoke-HFDownload delegates to the Node downloader and returns its ok" {
        function Resolve-TsModelDownloadScript { return "C:\fake\modelDownloadCli.js" }
        function Invoke-TsModelDownload { param($Repo,$File,$DestPath,$Script) return @{ ok = $true; action = 'restart'; bytes = 10 } }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-dl-{0}" -f [guid]::NewGuid().ToString('N'))
        try {
            $ok = Invoke-HFDownload -Repo "r/m" -File "m.gguf" -DestPath (Join-Path $tmp "m.gguf") -ExpectedBytes 10
            Assert-Equal $true $ok
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "Invoke-HFDownload surfaces a failed Node download" {
        function Resolve-TsModelDownloadScript { return "C:\fake\modelDownloadCli.js" }
        function Invoke-TsModelDownload { param($Repo,$File,$DestPath,$Script) return @{ ok = $false; action = 'restart'; reason = 'boom' } }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-dl-{0}" -f [guid]::NewGuid().ToString('N'))
        try {
            $ok = Invoke-HFDownload -Repo "r/m" -File "m.gguf" -DestPath (Join-Path $tmp "m.gguf") -ExpectedBytes 10
            Assert-Equal $false $ok
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "Invoke-HFDownload throws when the Node build is missing (no PowerShell fallback)" {
        function Resolve-TsModelDownloadScript { return "" }
        Assert-Throws {
            Invoke-HFDownload -Repo "r/m" -File "m.gguf" -DestPath (Join-Path ([System.IO.Path]::GetTempPath()) "m.gguf") -ExpectedBytes 10
        } "Node downloader build not found"
    }

    It "delegates regardless of -Force and an existing file (download decoupled from benchmark -Force)" {
        $oldForce = $script:Force
        $script:tsCalled = $false
        function Resolve-TsModelDownloadScript { return "C:\fake\modelDownloadCli.js" }
        function Invoke-TsModelDownload { param($Repo,$File,$DestPath,$Script) $script:tsCalled = $true; return @{ ok = $true; action = 'skip'; bytes = 10 } }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-dl-{0}" -f [guid]::NewGuid().ToString('N'))
        $dest = Join-Path $tmp "m.gguf"
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Set-Content -LiteralPath $dest -Value "present" -Encoding UTF8
        try {
            $script:Force = $true
            $ok = Invoke-HFDownload -Repo "r/m" -File "m.gguf" -DestPath $dest -ExpectedBytes 10
            Assert-Equal $true $ok
            Assert-Equal $true $script:tsCalled
        } finally {
            $script:Force = $oldForce
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Exit-WithResults
