# Integration tests for the first-run init path. These run calibr.ps1 in a
# subprocess because the contract is command-line behavior against an isolated
# config file, not just helper functions.
. "$PSScriptRoot\..\harness.ps1"

$labRoot = Resolve-Path "$PSScriptRoot\..\.."
$labScript = Join-Path $labRoot "calibr.ps1"

Describe "init command on partial local config" {
    It "augments a file-picker config instead of refusing to run" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-init-test-" + [guid]::NewGuid())
        $oldData = $env:CALIBR_DATA_DIR
        try {
            New-Item -ItemType Directory -Path $tmp -Force | Out-Null
            $cfgPath = Join-Path $tmp "config.json"
            $dataDir = Join-Path $tmp "data"
            $modelsDir = Join-Path $tmp "models"
            $llamaPath = Join-Path $tmp "llama-server.exe"
            New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
            New-Item -ItemType File -Path $llamaPath -Force | Out-Null

            @{ llama_server_exe = $llamaPath } |
                ConvertTo-Json -Depth 5 |
                Out-File -Encoding utf8 $cfgPath

            $env:CALIBR_DATA_DIR = $dataDir
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $labScript init -Config $cfgPath -ScanPath $modelsDir -NonInteractive 2>&1 | Out-String
            Assert-Equal 0 $LASTEXITCODE $out

            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            Assert-Equal $llamaPath $cfg.llama_server_exe
            Assert-Equal $modelsDir @($cfg.scan_paths)[0]
            Assert-True ($null -ne $cfg.hardware) "hardware block should be written"
            Assert-True ($cfg.hardware.PSObject.Properties.Name -contains "cpu_cores_physical") "CPU field should be present even if detection returns null"
        } finally {
            if ($null -eq $oldData) { Remove-Item Env:\CALIBR_DATA_DIR -ErrorAction SilentlyContinue }
            else { $env:CALIBR_DATA_DIR = $oldData }
            if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

Exit-WithResults
