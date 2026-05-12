param(
  [int[]]$Depths = @(2, 3, 4),
  [int]$Runs = 30
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Manifest = Join-Path $Root "benchmark-results/hetero-depth-manifest.json"

if (-not (Test-Path $Manifest)) {
  throw @"
Missing $Manifest.

The existing RQ1c production scripts implement the EVM--WASM--Fabric depth-2 workflow only.
Create this manifest after deploying real depth-3/depth-4 heterogeneous endpoints; do not reuse the depth-2 script as a fake scaling result.

Expected minimal schema:
{
  "depths": {
    "2": { "xsmart": "...", "gpact": "...", "atom": "..." },
    "3": { "xsmart": "...", "gpact": "...", "atom": "..." },
    "4": { "xsmart": "...", "gpact": "...", "atom": "..." }
  }
}
"@
}

$env:RUNS = "$Runs"
$manifestJson = Get-Content -Path $Manifest -Raw | ConvertFrom-Json
foreach ($depth in $Depths) {
  if (-not $manifestJson.depths."$depth") {
    throw "No hetero-depth workload entry for depth=$depth in $Manifest"
  }
  Write-Host "[RQ1c-depth] depth=$depth manifest entry found. Run the manifest-specific commands for XSmart/GPACT/AtomCI."
}
