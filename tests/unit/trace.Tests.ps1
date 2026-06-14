# Unit tests for action-level trace logging.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Write-TraceEvent" {
    It "writes a JSONL event to data/logs/action-trace.jsonl" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-trace-" + [guid]::NewGuid().ToString('N'))
        $oldLogs = $script:CALIBR_LOGS_DIR
        $oldData = $script:CALIBR_DATA_DIR
        $oldSession = $env:CALIBR_TRACE_SESSION_ID
        try {
            $script:CALIBR_DATA_DIR = Join-Path $tmp "data"
            $script:CALIBR_LOGS_DIR = Join-Path $script:CALIBR_DATA_DIR "logs"
            $env:CALIBR_TRACE_SESSION_ID = "test-session"
            $sensitivePath = Join-Path $script:CALIBR_DATA_DIR "llama-bin\b9360"
            Write-TraceEvent -Flow "guided run" -Action "llama.cpp > download" -Status "started" `
                -Message "guided run > llama.cpp > download started" `
                -Details @{ build = "latest"; path = $sensitivePath }

            $path = Join-Path $script:CALIBR_LOGS_DIR "action-trace.jsonl"
            Assert-True (Test-Path -LiteralPath $path) "trace file should be created"
            $line = Get-Content -LiteralPath $path -Raw
            $entry = $line | ConvertFrom-Json
            Assert-Equal "engine" $entry.source
            Assert-Equal "test-session" $entry.sessionId
            Assert-Equal "guided run" $entry.flow
            Assert-Equal "llama.cpp > download" $entry.action
            Assert-Equal "started" $entry.status
            Assert-Equal "latest" $entry.details.build
            Assert-True ($entry.details.path -like "<CALIBR_DATA_DIR>*") "JSONL path should be redacted"

            $humanPath = Join-Path $script:CALIBR_LOGS_DIR "action-trace.log"
            Assert-True (Test-Path -LiteralPath $humanPath) "human trace file should be created"
            $human = Get-Content -LiteralPath $humanPath -Raw
            Assert-True ($human -match "guided run") "human trace should include flow"
            Assert-True ($human -match "llama.cpp > download") "human trace should include action"
            Assert-True ($human -match "<CALIBR_DATA_DIR>") "human trace should redact data dir"
            Assert-False ($human -match [regex]::Escape($script:CALIBR_DATA_DIR)) "human trace should not leak data dir"
        } finally {
            $script:CALIBR_LOGS_DIR = $oldLogs
            $script:CALIBR_DATA_DIR = $oldData
            $env:CALIBR_TRACE_SESSION_ID = $oldSession
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Exit-WithResults

