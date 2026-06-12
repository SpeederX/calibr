# Unit tests for action-level trace logging.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Write-TraceEvent" {
    It "writes a JSONL event to data/logs/action-trace.jsonl" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-trace-" + [guid]::NewGuid().ToString('N'))
        $oldLogs = $script:CALIBR_LOGS_DIR
        try {
            $script:CALIBR_LOGS_DIR = Join-Path $tmp "logs"
            Write-TraceEvent -Flow "guided run" -Action "llama.cpp > download" -Status "started" `
                -Message "guided run > llama.cpp > download started" `
                -Details @{ build = "latest" }

            $path = Join-Path $script:CALIBR_LOGS_DIR "action-trace.jsonl"
            Assert-True (Test-Path -LiteralPath $path) "trace file should be created"
            $line = Get-Content -LiteralPath $path -Raw
            $entry = $line | ConvertFrom-Json
            Assert-Equal "engine" $entry.source
            Assert-Equal "guided run" $entry.flow
            Assert-Equal "llama.cpp > download" $entry.action
            Assert-Equal "started" $entry.status
            Assert-Equal "latest" $entry.details.build
        } finally {
            $script:CALIBR_LOGS_DIR = $oldLogs
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Exit-WithResults

