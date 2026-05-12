param(
  [int]$Runs = 30,
  [int]$GapSeconds = 180
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\UIT\randomly"
$RelayerBin = Join-Path $RepoRoot "relayer\relayer.exe"
$ResultsPath = Join-Path $RepoRoot "benchmark-results\rq1-baseline-run-log.txt"
$BenchmarkResultsDir = Join-Path $RepoRoot "benchmark-results"

Set-Location $RepoRoot

function Initialize-ResultsFile {
  if (Test-Path $ResultsPath) {
    Remove-Item $ResultsPath -Force
  }

  $lines = @(
    "# Benchmark Results"
    "",
    "- Status: running"
    "- StartedAt: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    "- RUNS: $Runs"
    "- GapSecondsBetweenCases: $GapSeconds"
    "- RQ1b worker policy: 4 workers for IntegrateX, ATOM, GPACT, XSmart"
    ""
    "## Completed Cases"
    ""
  )
  Set-Content -Path $ResultsPath -Value $lines -Encoding utf8
}

function Append-ResultLine {
  param(
    [string]$Line
  )
  Add-Content -Path $ResultsPath -Value $Line -Encoding utf8
}

function Clear-CheckpointFromConfig {
  param(
    [string]$ConfigPath
  )

  if (!(Test-Path $ConfigPath)) {
    return
  }

  $checkpointLine = Select-String -Path $ConfigPath -Pattern '^\s*checkpoint_file:\s*"([^"]+)"' | Select-Object -First 1
  if ($null -eq $checkpointLine) {
    return
  }

  $relativePath = $checkpointLine.Matches[0].Groups[1].Value
  if ([string]::IsNullOrWhiteSpace($relativePath)) {
    return
  }

  $absolutePath = Join-Path (Join-Path $RepoRoot "configs\relayer") $relativePath
  if (Test-Path $absolutePath) {
    Remove-Item $absolutePath -Force
  }
}

function Stop-AnyRelayer {
  Get-Process relayer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Format-Summary {
  param(
    [object]$Json
  )

  $summary = $Json.summary
  $avg = [double]$summary.avgSeconds
  $median = [double]$summary.medianSeconds
  $std = 0.0
  if ($null -ne $summary.stdSeconds) {
    $std = [double]$summary.stdSeconds
  }

  return "avg={0:N3}s median={1:N3}s std={2:N3}s runs={3}" -f $avg, $median, $std, $summary.runs
}

function Run-BenchmarkCase {
  param(
    [hashtable]$Case,
    [bool]$ShouldSleepAfter
  )

  $label = $Case.Label
  $configPath = Join-Path $RepoRoot $Case.Config
  $hardhatConfig = Join-Path $RepoRoot $Case.HardhatConfig
  $scriptPath = Join-Path $RepoRoot $Case.Script
  $outputPath = Join-Path $RepoRoot $Case.Output
  $relayerOut = Join-Path $BenchmarkResultsDir "$label-relayer.out.log"
  $relayerErr = Join-Path $BenchmarkResultsDir "$label-relayer.err.log"
  $benchLog = Join-Path $BenchmarkResultsDir "$label-benchmark.log"

  Append-ResultLine "- START $label at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"

  Stop-AnyRelayer
  Clear-CheckpointFromConfig -ConfigPath $configPath

  if (Test-Path $relayerOut) { Remove-Item $relayerOut -Force }
  if (Test-Path $relayerErr) { Remove-Item $relayerErr -Force }
  if (Test-Path $benchLog) { Remove-Item $benchLog -Force }

  $process = $null
  try {
    $process = Start-Process -FilePath $RelayerBin `
      -ArgumentList "start", "--config", $configPath `
      -WorkingDirectory $RepoRoot `
      -RedirectStandardOutput $relayerOut `
      -RedirectStandardError $relayerErr `
      -PassThru

    Start-Sleep -Seconds 5

    $env:RUNS = "$Runs"
    if ($Case.ContainsKey("Depth")) {
      $env:DEPTH = "$($Case.Depth)"
    } elseif (Test-Path Env:DEPTH) {
      Remove-Item Env:DEPTH -ErrorAction SilentlyContinue
    }

    & npx hardhat run --config $hardhatConfig $scriptPath --network besu 2>&1 | Tee-Object -FilePath $benchLog
    if ($LASTEXITCODE -ne 0) {
      throw "hardhat exited with code $LASTEXITCODE"
    }

    if (!(Test-Path $outputPath)) {
      throw "expected output not found: $outputPath"
    }

    $json = Get-Content $outputPath -Raw | ConvertFrom-Json
    $summaryText = Format-Summary -Json $json
    Append-ResultLine "- DONE ${label}: $summaryText; output=$(Split-Path $outputPath -Leaf)"
  }
  catch {
    Append-ResultLine "- FAIL ${label}: $($_.Exception.Message); benchLog=$(Split-Path $benchLog -Leaf); relayerErr=$(Split-Path $relayerErr -Leaf)"
  }
  finally {
    if ($process -and !$process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-AnyRelayer
    if (Test-Path Env:RUNS) {
      Remove-Item Env:RUNS -ErrorAction SilentlyContinue
    }
    if (Test-Path Env:DEPTH) {
      Remove-Item Env:DEPTH -ErrorAction SilentlyContinue
    }
  }

  if ($ShouldSleepAfter) {
    Append-ResultLine "- GAP after ${label}: sleeping ${GapSeconds}s"
    Start-Sleep -Seconds $GapSeconds
  }
}

$cases = @(
  @{ Label = "integratex-1a"; Config = "configs\relayer\config-integratex.yaml"; HardhatConfig = "hardhat.integratex-bc1.config.ts"; Script = "scripts\benchmark\benchmark-integratex-50.ts"; Output = "benchmark-results\integratex-50.json" },
  @{ Label = "atom-1a"; Config = "configs\relayer\config-atom.yaml"; HardhatConfig = "hardhat.atom-bc1.config.ts"; Script = "scripts\benchmark\benchmark-atom-50.ts"; Output = "benchmark-results\atom-write-50.json" },
  @{ Label = "gpact-1a"; Config = "configs\relayer\config-gpact.yaml"; HardhatConfig = "hardhat.gpact-bc1.config.ts"; Script = "scripts\benchmark\benchmark-gpact-50.ts"; Output = "benchmark-results\gpact-50.json" },
  @{ Label = "xsmart-1a"; Config = "configs\relayer\config-xsmart-1a.yaml"; HardhatConfig = "hardhat.xsmart-bc1.config.ts"; Script = "scripts\benchmark\benchmark-xsmart-1a.ts"; Output = "benchmark-results\xsmart-1a.json" },

  @{ Label = "integratex-1b-d2"; Config = "configs\relayer\config-integratex-1b-d2.yaml"; HardhatConfig = "hardhat.integratex-bc1.config.ts"; Script = "scripts\benchmark\benchmark-integratex-1b.ts"; Output = "benchmark-results\integratex-1b-d2.json"; Depth = 2 },
  @{ Label = "atom-1b-d2"; Config = "configs\relayer\config-atom-1b-d2.yaml"; HardhatConfig = "hardhat.atom-bc1.config.ts"; Script = "scripts\benchmark\benchmark-atom-1b.ts"; Output = "benchmark-results\atom-1b-d2.json"; Depth = 2 },
  @{ Label = "gpact-1b-d2"; Config = "configs\relayer\config-gpact-1b-d2.yaml"; HardhatConfig = "hardhat.gpact-bc1.config.ts"; Script = "scripts\benchmark\benchmark-gpact-1b.ts"; Output = "benchmark-results\gpact-1b-d2.json"; Depth = 2 },
  @{ Label = "xsmart-1b-d2"; Config = "configs\relayer\config-xsmart-1b-d2.yaml"; HardhatConfig = "hardhat.xsmart-bc1.config.ts"; Script = "scripts\benchmark\benchmark-xsmart-1b.ts"; Output = "benchmark-results\xsmart-1b-d2.json"; Depth = 2 },

  @{ Label = "integratex-1b-d3"; Config = "configs\relayer\config-integratex-1b-d3.yaml"; HardhatConfig = "hardhat.integratex-bc1.config.ts"; Script = "scripts\benchmark\benchmark-integratex-1b.ts"; Output = "benchmark-results\integratex-1b-d3.json"; Depth = 3 },
  @{ Label = "atom-1b-d3"; Config = "configs\relayer\config-atom-1b-d3.yaml"; HardhatConfig = "hardhat.atom-bc1.config.ts"; Script = "scripts\benchmark\benchmark-atom-1b.ts"; Output = "benchmark-results\atom-1b-d3.json"; Depth = 3 },
  @{ Label = "gpact-1b-d3"; Config = "configs\relayer\config-gpact-1b-d3.yaml"; HardhatConfig = "hardhat.gpact-bc1.config.ts"; Script = "scripts\benchmark\benchmark-gpact-1b.ts"; Output = "benchmark-results\gpact-1b-d3.json"; Depth = 3 },
  @{ Label = "xsmart-1b-d3"; Config = "configs\relayer\config-xsmart-1b-d3.yaml"; HardhatConfig = "hardhat.xsmart-bc1.config.ts"; Script = "scripts\benchmark\benchmark-xsmart-1b.ts"; Output = "benchmark-results\xsmart-1b-d3.json"; Depth = 3 },

  @{ Label = "integratex-1b-d4"; Config = "configs\relayer\config-integratex-1b-d4.yaml"; HardhatConfig = "hardhat.integratex-bc1.config.ts"; Script = "scripts\benchmark\benchmark-integratex-1b.ts"; Output = "benchmark-results\integratex-1b-d4.json"; Depth = 4 },
  @{ Label = "atom-1b-d4"; Config = "configs\relayer\config-atom-1b-d4.yaml"; HardhatConfig = "hardhat.atom-bc1.config.ts"; Script = "scripts\benchmark\benchmark-atom-1b.ts"; Output = "benchmark-results\atom-1b-d4.json"; Depth = 4 },
  @{ Label = "gpact-1b-d4"; Config = "configs\relayer\config-gpact-1b-d4.yaml"; HardhatConfig = "hardhat.gpact-bc1.config.ts"; Script = "scripts\benchmark\benchmark-gpact-1b.ts"; Output = "benchmark-results\gpact-1b-d4.json"; Depth = 4 },
  @{ Label = "xsmart-1b-d4"; Config = "configs\relayer\config-xsmart-1b-d4.yaml"; HardhatConfig = "hardhat.xsmart-bc1.config.ts"; Script = "scripts\benchmark\benchmark-xsmart-1b.ts"; Output = "benchmark-results\xsmart-1b-d4.json"; Depth = 4 },

  @{ Label = "integratex-1b-d5"; Config = "configs\relayer\config-integratex-1b-d5.yaml"; HardhatConfig = "hardhat.integratex-bc1.config.ts"; Script = "scripts\benchmark\benchmark-integratex-1b.ts"; Output = "benchmark-results\integratex-1b-d5.json"; Depth = 5 },
  @{ Label = "atom-1b-d5"; Config = "configs\relayer\config-atom-1b-d5.yaml"; HardhatConfig = "hardhat.atom-bc1.config.ts"; Script = "scripts\benchmark\benchmark-atom-1b.ts"; Output = "benchmark-results\atom-1b-d5.json"; Depth = 5 },
  @{ Label = "gpact-1b-d5"; Config = "configs\relayer\config-gpact-1b-d5.yaml"; HardhatConfig = "hardhat.gpact-bc1.config.ts"; Script = "scripts\benchmark\benchmark-gpact-1b.ts"; Output = "benchmark-results\gpact-1b-d5.json"; Depth = 5 },
  @{ Label = "xsmart-1b-d5"; Config = "configs\relayer\config-xsmart-1b-d5.yaml"; HardhatConfig = "hardhat.xsmart-bc1.config.ts"; Script = "scripts\benchmark\benchmark-xsmart-1b.ts"; Output = "benchmark-results\xsmart-1b-d5.json"; Depth = 5 }
)

Initialize-ResultsFile

for ($i = 0; $i -lt $cases.Count; $i++) {
  $shouldSleep = $i -lt ($cases.Count - 1)
  Run-BenchmarkCase -Case $cases[$i] -ShouldSleepAfter:$shouldSleep
}

Append-ResultLine ""
Append-ResultLine "- Status: completed"
Append-ResultLine "- FinishedAt: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
