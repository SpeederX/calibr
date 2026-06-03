# Static consistency checks for models_catalog.json + default_bench_presets.json.
# These catch the kind of drift where a new model is added to the catalog but
# forgotten in the presets (or vice versa: a preset entry referencing a typo'd
# catalog id). Pure file reads, no engine subprocess needed.
. "$PSScriptRoot\harness.ps1"

$labRoot      = (Resolve-Path "$PSScriptRoot\..").Path
$catalogPath  = Join-Path $labRoot "models_catalog.json"
$presetsPath  = Join-Path $labRoot "default_bench_presets.json"

$catalog = Get-Content $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$presets = Get-Content $presetsPath -Raw -Encoding UTF8 | ConvertFrom-Json

$catalogIds = @($catalog.models | ForEach-Object { $_.id })
$catalogIdSet = @{}
foreach ($id in $catalogIds) { $catalogIdSet[$id] = $true }

# Collect every preset that lists explicit models (skip presets like 'all'
# whose models field is the literal '*').
$explicitPresets = @{}
foreach ($name in $presets.presets.PSObject.Properties.Name) {
    $p = $presets.presets.$name
    if ($p.models -is [string] -and $p.models -eq '*') { continue }
    $explicitPresets[$name] = @($p.models)
}

Describe "models_catalog.json structure" {
    It "has at least one model" {
        Assert-True ($catalogIds.Count -gt 0)
    }
    It "every model has a unique id" {
        $dupes = $catalogIds | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }
        Assert-True ($dupes.Count -eq 0) ("duplicate ids: " + ($dupes -join ', '))
    }
    It "every model has the required fields (id, model, hf_repo, hf_file, target_dir, size_bytes)" {
        $missing = @()
        foreach ($m in $catalog.models) {
            foreach ($req in @('id', 'model', 'hf_repo', 'hf_file', 'target_dir', 'size_bytes')) {
                if (-not $m.PSObject.Properties.Name -contains $req -or $null -eq $m.$req) {
                    $missing += "{0}: missing {1}" -f $m.id, $req
                }
            }
        }
        Assert-True ($missing.Count -eq 0) ("required fields missing: " + ($missing -join '; '))
    }
}

Describe "default_bench_presets.json references the catalog" {
    It "every preset id resolves to a catalog entry" {
        $unknown = @()
        foreach ($presetName in $explicitPresets.Keys) {
            foreach ($id in $explicitPresets[$presetName]) {
                if (-not $catalogIdSet.ContainsKey($id)) {
                    $unknown += "preset '{0}' references unknown id '{1}'" -f $presetName, $id
                }
            }
        }
        Assert-True ($unknown.Count -eq 0) ("dangling preset refs: " + ($unknown -join '; '))
    }
    It "every catalog id appears in at least one preset (sanity: nothing forgotten)" {
        # This guards against the v0.1.4 bug where 18 new catalog entries were
        # added but never propagated into low/middle/high presets, so the user
        # only saw the 5 original models when picking the 'low' preset.
        $coverage = @{}
        foreach ($id in $catalogIds) { $coverage[$id] = 0 }
        foreach ($presetName in $explicitPresets.Keys) {
            foreach ($id in $explicitPresets[$presetName]) {
                if ($coverage.ContainsKey($id)) { $coverage[$id]++ }
            }
        }
        $orphans = @($coverage.Keys | Where-Object { $coverage[$_] -eq 0 })
        Assert-True ($orphans.Count -eq 0) ("catalog ids not in any preset: " + ($orphans -join ', '))
    }
    It "no catalog id is split across multiple presets (avoids ambiguous routing)" {
        $coverage = @{}
        foreach ($id in $catalogIds) { $coverage[$id] = @() }
        foreach ($presetName in $explicitPresets.Keys) {
            foreach ($id in $explicitPresets[$presetName]) {
                if ($coverage.ContainsKey($id)) { $coverage[$id] += $presetName }
            }
        }
        $duplicated = @($coverage.Keys | Where-Object { $coverage[$_].Count -gt 1 })
        if ($duplicated.Count -gt 0) {
            $detail = $duplicated | ForEach-Object { "{0} in {1}" -f $_, ($coverage[$_] -join '+') }
            Assert-True $false ("ids in multiple presets: " + ($detail -join '; '))
        } else {
            Assert-True $true
        }
    }
}

Exit-WithResults
