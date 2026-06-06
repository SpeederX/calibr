# Unit tests for platform parser helpers.
. "$PSScriptRoot\..\harness.ps1"
. "$PSScriptRoot\..\..\calibr.ps1"

Describe "ConvertFrom-AmdSmiMetricJson" {
    It "parses AMD metric JSON with mixed units" {
        $json = @"
{
  "gpu": [
    {
      "vram": { "used": "1024 MB", "total": "24 GB" },
      "power": { "current": "125.6 W" },
      "temperature": { "edge": "63 C" },
      "activity": { "gfx": "78%" }
    }
  ]
}
"@
        $r = ConvertFrom-AmdSmiMetricJson $json
        Assert-Equal 1024 $r.mem_mib
        Assert-Equal 24576 $r.total_mib
        Assert-Equal 125.6 $r.power_w
        Assert-Equal 63 $r.temp_c
        Assert-Equal 78 $r.util_pct
    }

    It "returns zeros for invalid JSON" {
        $r = ConvertFrom-AmdSmiMetricJson "{nope"
        Assert-Equal 0 $r.mem_mib
        Assert-Equal 0 $r.total_mib
        Assert-Equal 0.0 $r.power_w
    }
}

Describe "ConvertFrom-AmdSmiStaticJson" {
    It "parses GPU name and byte-sized VRAM totals" {
        $json = @"
{
  "cards": [
    {
      "product": { "name": "AMD Radeon RX 7900 XTX" },
      "memory_total_bytes": 25769803776
    }
  ]
}
"@
        $r = ConvertFrom-AmdSmiStaticJson $json
        Assert-Equal "AMD Radeon RX 7900 XTX" $r.gpu_name
        Assert-Equal 24576 $r.vram_total_mib
    }
}

Describe "ConvertFrom-MacDisplaysData" {
    It "detects Metal-capable Apple GPUs" {
        $txt = @"
Graphics/Displays:

    Apple M3:

      Chipset Model: Apple M3
      Type: GPU
      Bus: Built-In
      Metal Support: Metal 3
"@
        $r = ConvertFrom-MacDisplaysData $txt
        Assert-Equal "Apple M3" $r.gpu_name
        Assert-True $r.metal_supported
    }

    It "treats explicit unsupported Metal as false" {
        $txt = @"
Chipset Model: Intel HD Graphics 4000
Metal Support: Unsupported
"@
        $r = ConvertFrom-MacDisplaysData $txt
        Assert-Equal "Intel HD Graphics 4000" $r.gpu_name
        Assert-False $r.metal_supported
    }
}

Exit-WithResults
