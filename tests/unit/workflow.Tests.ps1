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
