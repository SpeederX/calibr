# Unit tests for guided workflow orchestration.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Workflow catalog scope" {
    It "returns entries and planner policy without script-scoped preset state" {
        function Get-ModelCatalog {
            return @([pscustomobject]@{ id = "model-a"; model = "Model A" })
        }

        $script:Preset = ""
        $script:CatalogId = ""
        $script:Model = ""
        $script:ContextSizes = "16384,32768"

        $scope = Resolve-WorkflowCatalogScope

        Assert-Equal 1 $scope.entries.Count
        Assert-Equal 0 $scope.planning_policy.max_context
        Assert-Equal 2 $scope.planning_policy.context_sizes.Count
    }
}

Describe "Workflow benchmark scope by source" {
    # NOTE: the stub functions below are defined INSIDE each It block on purpose.
    # PowerShell resolves command names through the dynamic call stack, so a stub
    # defined here shadows the real workflow stage when Invoke-All calls it. If
    # the stubs were hoisted into a helper function they would fall out of scope
    # and Invoke-All would run the real bench/catalog workflow against the live
    # config - i.e. actually benchmark the user's models. Keep them inline.

    It "catalog-download mode benchmarks only the catalog scope, not the whole scan folder" {
        $script:benchCycleCalled = $false
        $script:catalogWorkflowCalled = $false
        function Ensure-WorkflowEngine {}
        function Ensure-WorkflowScanPath {}
        function Invoke-Report {}
        function Invoke-WorkflowBenchCycle { $script:benchCycleCalled = $true }
        function Invoke-CatalogWorkflow { $script:catalogWorkflowCalled = $true }
        function Resolve-WorkflowCatalogScope {
            return @{
                entries = @([pscustomobject]@{ id = "entry-a"; model = "Model A" })
                planning_policy = (New-PlanningPolicy)
            }
        }
        $script:CatalogId = ""; $script:Model = ""; $script:Preset = ""
        $script:ContextSizes = ""; $script:WorkloadSweep = "baseline"
        $script:FetchCatalog = $true

        Invoke-All

        # The scan folder is a cache here: no full-folder bench cycle, only the
        # scoped catalog workflow runs.
        Assert-Equal $false $script:benchCycleCalled
        Assert-Equal $true $script:catalogWorkflowCalled
    }

    It "local-folder mode benchmarks everything discovered in the scan folder" {
        $script:benchCycleCalled = $false
        $script:catalogWorkflowCalled = $false
        function Ensure-WorkflowEngine {}
        function Invoke-Report {}
        function Invoke-WorkflowBenchCycle { $script:benchCycleCalled = $true }
        function Invoke-CatalogWorkflow { $script:catalogWorkflowCalled = $true }
        $script:CatalogId = ""; $script:Model = ""; $script:Preset = ""
        $script:ContextSizes = ""; $script:WorkloadSweep = "baseline"
        $script:FetchCatalog = $false

        Invoke-All

        Assert-Equal $true $script:benchCycleCalled
        Assert-Equal $false $script:catalogWorkflowCalled
    }
}

Describe "Workflow state cleanup" {
    It "restores outer catalog filters when a catalog entry fails" {
        function Resolve-TsModelIntakeScript { return "" }   # skip the pre-pass (no node spawn)
        function Invoke-CatalogEntry {
            $script:CatalogId = "temporary-id"
            $script:Model = "temporary-model"
            throw "simulated bench failure"
        }

        $script:CatalogId = "outer-id"
        $script:Model = "outer-model"

        Assert-Throws {
            Invoke-CatalogWorkflow `
                -CatalogEntries @([pscustomobject]@{ id = "entry"; model = "Model" }) `
                -PlanningPolicy (New-PlanningPolicy)
        } "simulated bench failure"

        Assert-Equal "outer-id" $script:CatalogId
        Assert-Equal "outer-model" $script:Model
    }
}

Describe "Catalog entry intake (lean) vs fallback" {
    It "uses Node intake and skips the per-entry discover when an intake script is present" {
        $origCatalog = $script:CALIBR_CATALOG
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-intake-{0}.json" -f [guid]::NewGuid().ToString('N'))
        $script:CALIBR_CATALOG = $tmp
        $script:discoverCalled = $false; $script:planCalled = $false; $script:benchCalled = $false
        function Get-Config { return @{} }
        function Get-DownloadRoot { param($cfg) return "/root" }
        function Invoke-TsCatalogIntake { param($Entry, $DestRoot, $Script) return @{ ok = $true; downloaded = $false; metadata = @{ model = "M"; path = "/root/M/m.gguf"; size_bytes = 1; mmproj = $null } } }
        function Invoke-Discover { $script:discoverCalled = $true }
        function Invoke-FetchModels { $script:discoverCalled = $true }
        function Invoke-Plan { $script:planCalled = $true }
        function Invoke-Bench { $script:benchCalled = $true }
        function Add-MoeWorkloadDiagnostics { return 0 }
        $script:CatalogId = ""; $script:Model = ""
        try {
            Invoke-CatalogEntry -Entry ([pscustomobject]@{ id = "e"; model = "M" }) -Number 1 -Total 1 -PlanningPolicy (New-PlanningPolicy) -IntakeScript "x"
            Assert-Equal $false $script:discoverCalled    # no per-entry full discover
            Assert-Equal $true $script:planCalled
            Assert-Equal $true $script:benchCalled
        } finally {
            $script:CALIBR_CATALOG = $origCatalog
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    It "falls back to fetch+discover when no intake script is available" {
        $script:discoverCalled = $false; $script:benchCalled = $false
        function Invoke-FetchModels { $script:discoverCalled = $true }
        function Invoke-Discover { $script:discoverCalled = $true }
        function Invoke-Plan {}
        function Invoke-Bench { $script:benchCalled = $true }
        function Add-MoeWorkloadDiagnostics { return 0 }
        $script:CatalogId = ""; $script:Model = ""
        Invoke-CatalogEntry -Entry ([pscustomobject]@{ id = "e"; model = "M" }) -Number 1 -Total 1 -PlanningPolicy (New-PlanningPolicy) -IntakeScript ""
        Assert-Equal $true $script:discoverCalled
        Assert-Equal $true $script:benchCalled
    }

    It "skips the model (no plan/bench) when intake reports an error" {
        $origCatalog = $script:CALIBR_CATALOG
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("calibr-intake-{0}.json" -f [guid]::NewGuid().ToString('N'))
        $script:CALIBR_CATALOG = $tmp
        $script:planCalled = $false; $script:benchCalled = $false
        function Get-Config { return @{} }
        function Get-DownloadRoot { param($cfg) return "/root" }
        function Invoke-TsCatalogIntake { param($Entry, $DestRoot, $Script) return @{ ok = $false; error = "GGUF signature mismatch" } }
        function Invoke-Discover {}
        function Invoke-FetchModels {}
        function Invoke-Plan { $script:planCalled = $true }
        function Invoke-Bench { $script:benchCalled = $true }
        function Add-MoeWorkloadDiagnostics { return 0 }
        $script:CatalogId = ""; $script:Model = ""
        try {
            Invoke-CatalogEntry -Entry ([pscustomobject]@{ id = "e"; model = "M" }) -Number 1 -Total 1 -PlanningPolicy (New-PlanningPolicy) -IntakeScript "x"
            Assert-Equal $false $script:planCalled
            Assert-Equal $false $script:benchCalled
        } finally {
            $script:CALIBR_CATALOG = $origCatalog
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

Exit-WithResults
