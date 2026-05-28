# Integration tests for the `config` subcommand. Spawns the script as a real
# subprocess so we exercise the full dispatch path (param binding, dot-source
# guard, exit codes), then inspects the on-disk config.json. We isolate state
# by pointing -Config at a throwaway file in the system temp dir.
. "$PSScriptRoot\harness.ps1"

$labRoot   = (Resolve-Path "$PSScriptRoot\..").Path
$labScript = Join-Path $labRoot "calibr.ps1"
$tmpCfg    = Join-Path ([System.IO.Path]::GetTempPath()) "calibr-test-config-$([Guid]::NewGuid().ToString('N')).json"

function Invoke-Lab {
    # Run the script with -Config pointing at our throwaway file. Returns
    # @{ stdout=...; exit=int }.
    # NB: the parameter is $LabArgs, not $Args — $Args is a reserved
    # PowerShell automatic and shadowing it silently drops the values.
    param([string[]]$LabArgs)
    $allArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $labScript, "-Config", $tmpCfg) + $LabArgs
    $out = & powershell.exe @allArgs 2>&1 | Out-String
    return @{ stdout = $out; exit = $LASTEXITCODE }
}

function Read-TmpCfg {
    if (-not (Test-Path $tmpCfg)) { return @{} }
    return Get-Content $tmpCfg -Raw | ConvertFrom-Json
}

# Clean up at script end regardless of pass/fail.
trap { if (Test-Path $tmpCfg) { Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue } }

Describe "config (no action)" {
    It "prints usage banner" {
        $r = Invoke-Lab -LabArgs @("config")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "Usage: calibr config")  "stdout was: $($r.stdout)"
        Assert-True ($r.stdout -match "list")
        Assert-True ($r.stdout -match "set <key> <value>")
        Assert-True ($r.stdout -match "detect")
    }
}

Describe "config list" {
    It "shows keys with type and source markers" {
        $r = Invoke-Lab -LabArgs @("config", "list")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "hardware\.vram_safety_budget_pct")
        Assert-True ($r.stdout -match "\(float\)")
        Assert-True ($r.stdout -match "\[default\]")
    }
}

Describe "config get / set / unset roundtrip" {
    It "get returns default before any set" {
        $r = Invoke-Lab -LabArgs @("config", "get", "wddm_detection.shared_delta_confirm_mib")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "= 500")
        Assert-True ($r.stdout -match "\[default\]")
    }
    It "set writes a value as the right type" {
        $r = Invoke-Lab -LabArgs @("config", "set", "wddm_detection.shared_delta_confirm_mib", "777")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "set wddm_detection")
        $cfg = Read-TmpCfg
        Assert-Equal 777 $cfg.wddm_detection.shared_delta_confirm_mib
    }
    It "get returns the local value after set" {
        $r = Invoke-Lab -LabArgs @("config", "get", "wddm_detection.shared_delta_confirm_mib")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "= 777")
        Assert-True ($r.stdout -match "\[local\]")
    }
    It "unset removes the override and prunes empty parent" {
        $r = Invoke-Lab -LabArgs @("config", "unset", "wddm_detection.shared_delta_confirm_mib")
        Assert-Equal 0 $r.exit
        $cfg = Read-TmpCfg
        Assert-False ($cfg.PSObject.Properties.Name -contains "wddm_detection") "wddm_detection should be pruned"
    }
    It "get falls back to default after unset" {
        $r = Invoke-Lab -LabArgs @("config", "get", "wddm_detection.shared_delta_confirm_mib")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "= 500")
        Assert-True ($r.stdout -match "\[default\]")
    }
}

Describe "config set type coercion" {
    It "writes a bool" {
        Invoke-Lab -LabArgs @("config", "set", "bench.warmup", "false") | Out-Null
        $cfg = Read-TmpCfg
        Assert-Equal $false $cfg.bench.warmup
        Invoke-Lab -LabArgs @("config", "unset", "bench.warmup") | Out-Null
    }
    It "writes a float" {
        Invoke-Lab -LabArgs @("config", "set", "hardware.vram_safety_budget_pct", "0.93") | Out-Null
        $cfg = Read-TmpCfg
        Assert-Equal 0.93 $cfg.hardware.vram_safety_budget_pct
        Invoke-Lab -LabArgs @("config", "unset", "hardware.vram_safety_budget_pct") | Out-Null
    }
    It "writes an array from CSV" {
        Invoke-Lab -LabArgs @("config", "set", "exclude_patterns", "*.bak,*.tmp") | Out-Null
        $cfg = Read-TmpCfg
        Assert-Equal 2 $cfg.exclude_patterns.Count
        Assert-Equal "*.bak" $cfg.exclude_patterns[0]
        Assert-Equal "*.tmp" $cfg.exclude_patterns[1]
        Invoke-Lab -LabArgs @("config", "unset", "exclude_patterns") | Out-Null
    }
}

Describe "bench.runs_per_config roundtrip (v1.1.0)" {
    It "default is 3" {
        $r = Invoke-Lab -LabArgs @("config", "get", "bench.runs_per_config")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "= 3")
        Assert-True ($r.stdout -match "\[default\]")
    }
    It "set + get + unset roundtrip" {
        $r = Invoke-Lab -LabArgs @("config", "set", "bench.runs_per_config", "5")
        Assert-Equal 0 $r.exit
        $cfg = Read-TmpCfg
        Assert-Equal 5 $cfg.bench.runs_per_config

        $r = Invoke-Lab -LabArgs @("config", "get", "bench.runs_per_config")
        Assert-True ($r.stdout -match "= 5")
        Assert-True ($r.stdout -match "\[local\]")

        Invoke-Lab -LabArgs @("config", "unset", "bench.runs_per_config") | Out-Null
        $r = Invoke-Lab -LabArgs @("config", "get", "bench.runs_per_config")
        Assert-True ($r.stdout -match "= 3")
        Assert-True ($r.stdout -match "\[default\]")
    }
}

Describe "config error cases" {
    It "rejects an unknown key" {
        $r = Invoke-Lab -LabArgs @("config", "set", "nope.does_not_exist", "1")
        Assert-True ($r.exit -ne 0) "should fail; got exit=$($r.exit)"
        Assert-True ($r.stdout -match "not in config\.default\.json")
    }
    It "rejects setting a whole object" {
        $r = Invoke-Lab -LabArgs @("config", "set", "hardware", "value")
        Assert-True ($r.exit -ne 0)
        Assert-True ($r.stdout -match "leaf keys individually")
    }
    It "prints usage on unknown action" {
        $r = Invoke-Lab -LabArgs @("config", "totally_bogus_action")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "Unknown config action")
        Assert-True ($r.stdout -match "Usage: calibr config")
    }
}

Describe "help system" {
    It "lists all commands without args" {
        $r = Invoke-Lab -LabArgs @("help")
        Assert-Equal 0 $r.exit
        foreach ($cmd in @("init", "discover", "plan", "bench", "report", "all", "status", "config", "install", "uninstall", "help")) {
            Assert-True ($r.stdout -match "\b$cmd\b") "expected '$cmd' in help output"
        }
    }
    It "shows per-command details" {
        $r = Invoke-Lab -LabArgs @("help", "config")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "Examples:")
        Assert-True ($r.stdout -match "calibr config detect")
    }
    It "handles unknown command gracefully" {
        $r = Invoke-Lab -LabArgs @("help", "definitelynotacommand")
        Assert-Equal 0 $r.exit
        Assert-True ($r.stdout -match "Unknown command")
    }
}

# Cleanup
if (Test-Path $tmpCfg) { Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue }

Exit-WithResults
