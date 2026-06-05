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


