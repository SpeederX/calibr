# Unit tests for guided workflow orchestration.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "Workflow catalog scope" {
    It "matches comma-expanded catalog id patterns without nested pipeline returns" {
        Assert-True (Test-WorkflowCatalogId -Id "qwen3.5-9b-q4" -Patterns @("qwen*", "gemma*"))
        Assert-False (Test-WorkflowCatalogId -Id "phi-4-mini" -Patterns @("qwen*", "gemma*"))
    }

    It "clears preset planning policy when no preset is active" {
        function Get-ModelCatalog {
            return @([pscustomobject]@{ id = "model-a"; model = "Model A" })
        }

        $script:Preset = ""
        $script:CatalogId = ""
        $script:Model = ""
        $script:_presetMaxCtx = 131072
        $script:_presetCtxSizes = @(16384, 32768)

        $entries = @(Resolve-WorkflowCatalogEntries)

        Assert-Equal 1 $entries.Count
        Assert-Equal 0 $script:_presetMaxCtx
        Assert-Equal 0 $script:_presetCtxSizes.Count
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
            Invoke-CatalogWorkflow -CatalogEntries @([pscustomobject]@{ id = "entry"; model = "Model" })
        } "simulated bench failure"

        Assert-Equal "outer-id" $script:CatalogId
        Assert-Equal "outer-model" $script:Model
    }
}

Exit-WithResults
