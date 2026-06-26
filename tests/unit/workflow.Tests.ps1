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

Exit-WithResults
