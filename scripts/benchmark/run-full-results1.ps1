param(
  [int]$Runs = 30,
  [int]$InterBenchmarkSleepSeconds = 0
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResultsPath = Join-Path $Root "benchmark-results\rq1-run-log.txt"
$RelayerExe = Join-Path $Root "relayer\relayer.exe"
$ProxyName = "xsmart-bc2-rpc-proxy"

function Write-ResultHeader {
  $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
  @(
    "# Results1 Full End-to-End Benchmark",
    "",
    "- Generated: $now",
    "- Runs per benchmark: $Runs",
    "- Execution: sequential, one protocol relayer at a time",
    "- Worker count: configs use 4 workers",
    "- RQ1c: EVM + WASM + Fabric; IntegrateX is unsupported and recorded as N/A",
    "",
    "| Experiment | Protocol | Depth/Scenario | Runs | Mean (s) | Median (s) | Std (s) | Status | Output |",
    "|---|---|---:|---:|---:|---:|---:|---|---|"
  ) | Set-Content -Path $ResultsPath -Encoding UTF8
}

function Add-ResultRow {
  param(
    [string]$Experiment,
    [string]$Protocol,
    [string]$Scenario,
    [string]$Output,
    [string]$Status = "ok"
  )

  if ($Status -ne "ok") {
    "| $Experiment | $Protocol | $Scenario | N/A | N/A | N/A | N/A | $Status | $Output |" |
      Add-Content -Path $ResultsPath -Encoding UTF8
    return
  }

  $jsonPath = Join-Path $Root $Output
  if (!(Test-Path $jsonPath)) {
    "| $Experiment | $Protocol | $Scenario | N/A | N/A | N/A | N/A | missing output | $Output |" |
      Add-Content -Path $ResultsPath -Encoding UTF8
    return
  }

  $json = Get-Content -Raw $jsonPath | ConvertFrom-Json
  $summary = $json.summary
  $std = if ($null -ne $summary.stdSeconds) { "{0:N3}" -f [double]$summary.stdSeconds } else { "N/A" }
  $mean = "{0:N3}" -f [double]$summary.avgSeconds
  $median = "{0:N3}" -f [double]$summary.medianSeconds
  "| $Experiment | $Protocol | $Scenario | $($summary.runs) | $mean | $median | $std | ok | $Output |" |
    Add-Content -Path $ResultsPath -Encoding UTF8
}

function Stop-ExistingRelayers {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $RelayerExe } |
    ForEach-Object { Stop-Process -Id $_.Id -Force }
}

function Ensure-DockerReady {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    return
  }
  $dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (!(Test-Path $dockerDesktop)) {
    throw "Docker Desktop executable not found: $dockerDesktop"
  }
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(250)
  do {
    Start-Sleep -Seconds 5
    docker info *> $null
    if ($LASTEXITCODE -eq 0) {
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "Docker engine did not become ready within 250s"
}

function Ensure-Bc2Proxy {
  Ensure-DockerReady
  $running = docker ps --filter "name=$ProxyName" --format "{{.Names}}"
  if ($running -eq $ProxyName) {
    return
  }
  docker rm -f $ProxyName *> $null
  docker run -d --name $ProxyName alpine/socat -d -d TCP-LISTEN:18545,fork,reuseaddr TCP:170.64.194.4:18545 | Out-Null
  Start-Sleep -Seconds 2
}

function Clear-Checkpoint {
  param([string]$CheckpointName)
  $path = Join-Path $Root "configs\relayer\var\$CheckpointName"
  Remove-Item -Force $path -ErrorAction SilentlyContinue
}

function Set-EnvMap {
  param([hashtable]$Map)
  $old = @{}
  foreach ($key in $Map.Keys) {
    $old[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Map[$key], "Process")
  }
  return $old
}

function Restore-EnvMap {
  param([hashtable]$Old)
  foreach ($key in $Old.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Old[$key], "Process")
  }
}

function Invoke-WithOptionalRelayer {
  param(
    [string]$Name,
    [string]$Experiment,
    [string]$Protocol,
    [string]$Scenario,
    [string]$Output,
    [string]$Config,
    [string[]]$Command,
    [hashtable]$ExtraEnv = @{},
    [string]$Checkpoint = ""
  )

  Write-Host "==== START $Name ===="
  Stop-ExistingRelayers
  if ($Checkpoint -ne "") {
    Clear-Checkpoint $Checkpoint
  }

  $envMap = @{
    RUNS = "$Runs"
  }
  foreach ($key in $ExtraEnv.Keys) {
    $envMap[$key] = $ExtraEnv[$key]
  }
  $oldEnv = Set-EnvMap $envMap

  $relayer = $null
  try {
    if ($Config -ne "") {
      $relayer = Start-Process -FilePath $RelayerExe `
        -ArgumentList "start","--config",(Join-Path $Root $Config) `
        -PassThru -WindowStyle Hidden
      Start-Sleep -Seconds 5
    }

    & $Command[0] @($Command[1..($Command.Length - 1)])
    if ($LASTEXITCODE -ne 0) {
      throw "$Name failed with exit code $LASTEXITCODE"
    }
    Add-ResultRow -Experiment $Experiment -Protocol $Protocol -Scenario $Scenario -Output $Output
    Write-Host "==== DONE $Name ===="
  } catch {
    Add-ResultRow -Experiment $Experiment -Protocol $Protocol -Scenario $Scenario -Output $Output -Status ("failed: " + $_.Exception.Message.Replace("|", "/"))
    throw
  } finally {
    if ($null -ne $relayer -and -not $relayer.HasExited) {
      Stop-Process -Id $relayer.Id -Force
    }
    Restore-EnvMap $oldEnv
    Stop-ExistingRelayers
  }

  if ($InterBenchmarkSleepSeconds -gt 0) {
    Start-Sleep -Seconds $InterBenchmarkSleepSeconds
  }
}

function Invoke-HardhatBenchmark {
  param(
    [string]$Name,
    [string]$Experiment,
    [string]$Protocol,
    [string]$Scenario,
    [string]$Output,
    [string]$RelayerConfig,
    [string]$HardhatConfig,
    [string]$Script,
    [hashtable]$ExtraEnv = @{},
    [string]$Checkpoint = ""
  )
  Invoke-WithOptionalRelayer `
    -Name $Name `
    -Experiment $Experiment `
    -Protocol $Protocol `
    -Scenario $Scenario `
    -Output $Output `
    -Config $RelayerConfig `
    -Command @("npx", "hardhat", "run", "--config", $HardhatConfig, $Script, "--network", "besu") `
    -ExtraEnv $ExtraEnv `
    -Checkpoint $Checkpoint
}

function Invoke-XSmartProd {
  Ensure-Bc2Proxy
  Invoke-WithOptionalRelayer `
    -Name "RQ1c XSmart" `
    -Experiment "1c" `
    -Protocol "XSmart" `
    -Scenario "EVM+WASM+Fabric" `
    -Output "benchmark-results/xsmart-prod.json" `
    -Config "" `
    -Command @("npx", "ts-node", "--project", "tsconfig.scripts.json", "scripts/benchmark/benchmark-xsmart-prod.ts") `
    -ExtraEnv @{
      XSMART_USE_BC2_DOCKER_PROXY = "1"
      XSMART_BC2_DEPLOY_MODE = "prod"
      XSMART_WASM_RUNNER = "docker"
      XSMART_BC2_DOCKER_NETWORK = "container:$ProxyName"
      XSMART_BC2_DOCKER_WS_URL = "ws://127.0.0.1:18545"
    } `
    -Checkpoint "xsmart-ckpt.json"
}

Set-Location $Root
Write-ResultHeader
Stop-ExistingRelayers
go -C relayer build -o relayer.exe ./cmd/relayer
if ($LASTEXITCODE -ne 0) {
  throw "relayer build failed"
}

# RQ1a
Invoke-HardhatBenchmark -Name "RQ1a IntegrateX" -Experiment "1a" -Protocol "IntegrateX" -Scenario "representative 2-chain EVM" -Output "benchmark-results/integratex-50.json" -RelayerConfig "configs\relayer\config-integratex.yaml" -HardhatConfig "hardhat.integratex-bc1.config.ts" -Script "scripts/benchmark/benchmark-integratex-50.ts"
Invoke-HardhatBenchmark -Name "RQ1a ATOM" -Experiment "1a" -Protocol "ATOM" -Scenario "representative write 2-chain EVM" -Output "benchmark-results/atom-write-50.json" -RelayerConfig "configs\relayer\config-atom.yaml" -HardhatConfig "hardhat.atom-bc1.config.ts" -Script "scripts/benchmark/benchmark-atom-50.ts"
Invoke-HardhatBenchmark -Name "RQ1a GPACT" -Experiment "1a" -Protocol "GPACT" -Scenario "representative 2-segment EVM" -Output "benchmark-results/gpact-50.json" -RelayerConfig "configs\relayer\config-gpact.yaml" -HardhatConfig "hardhat.gpact-bc1.config.ts" -Script "scripts/benchmark/benchmark-gpact-50.ts"
Invoke-HardhatBenchmark -Name "RQ1a XSmart" -Experiment "1a" -Protocol "XSmart" -Scenario "representative 2-chain homogeneous EVM" -Output "benchmark-results/xsmart-1a.json" -RelayerConfig "configs\relayer\config-xsmart-1a.yaml" -HardhatConfig "hardhat.xsmart-bc1.config.ts" -Script "scripts/benchmark/benchmark-xsmart-1a.ts"

# RQ1b
foreach ($depth in 2, 3, 4, 5) {
  Invoke-HardhatBenchmark -Name "RQ1b IntegrateX d=$depth" -Experiment "1b" -Protocol "IntegrateX" -Scenario "d=$depth" -Output "benchmark-results/integratex-1b-d$depth.json" -RelayerConfig "configs\relayer\config-integratex-1b-d$depth.yaml" -HardhatConfig "hardhat.integratex-bc1.config.ts" -Script "scripts/benchmark/benchmark-integratex-1b.ts" -ExtraEnv @{ DEPTH = "$depth" }
}
foreach ($depth in 2, 3, 4, 5) {
  Invoke-HardhatBenchmark -Name "RQ1b ATOM d=$depth" -Experiment "1b" -Protocol "ATOM" -Scenario "d=$depth" -Output "benchmark-results/atom-1b-d$depth.json" -RelayerConfig "configs\relayer\config-atom-1b-d$depth.yaml" -HardhatConfig "hardhat.atom-bc1.config.ts" -Script "scripts/benchmark/benchmark-atom-1b.ts" -ExtraEnv @{ DEPTH = "$depth" }
}
foreach ($depth in 2, 3, 4, 5) {
  Invoke-HardhatBenchmark -Name "RQ1b GPACT d=$depth" -Experiment "1b" -Protocol "GPACT" -Scenario "d=$depth" -Output "benchmark-results/gpact-1b-d$depth.json" -RelayerConfig "configs\relayer\config-gpact-1b-d$depth.yaml" -HardhatConfig "hardhat.gpact-bc1.config.ts" -Script "scripts/benchmark/benchmark-gpact-1b.ts" -ExtraEnv @{ DEPTH = "$depth" }
}
foreach ($depth in 2, 3, 4, 5) {
  Invoke-HardhatBenchmark -Name "RQ1b XSmart d=$depth" -Experiment "1b" -Protocol "XSmart" -Scenario "d=$depth" -Output "benchmark-results/xsmart-1b-d$depth.json" -RelayerConfig "configs\relayer\config-xsmart-1b-d$depth.yaml" -HardhatConfig "hardhat.xsmart-bc1.config.ts" -Script "scripts/benchmark/benchmark-xsmart-1b.ts" -ExtraEnv @{ DEPTH = "$depth" }
}

# RQ1c
Invoke-XSmartProd

$rq1cEnv = @{
  XSMART_BC2_DEPLOY_MODE = "prod"
  XSMART_WASM_RUNNER = "docker"
  XSMART_BC2_DOCKER_NETWORK = "container:$ProxyName"
  XSMART_BC2_DOCKER_WS_URL = "ws://127.0.0.1:18545"
}
Ensure-Bc2Proxy
Invoke-HardhatBenchmark -Name "RQ1c ATOM" -Experiment "1c" -Protocol "ATOM" -Scenario "EVM+WASM+Fabric" -Output "benchmark-results/atom-prod.json" -RelayerConfig "configs\relayer\config-atom-rq1c.yaml" -HardhatConfig "hardhat.atom-bc1.config.ts" -Script "scripts/benchmark/benchmark-atom-prod.ts" -ExtraEnv $rq1cEnv -Checkpoint "atom-rq1c-ckpt.json"
Ensure-Bc2Proxy
Invoke-HardhatBenchmark -Name "RQ1c GPACT" -Experiment "1c" -Protocol "GPACT" -Scenario "EVM+WASM+Fabric" -Output "benchmark-results/gpact-prod.json" -RelayerConfig "configs\relayer\config-gpact-rq1c.yaml" -HardhatConfig "hardhat.gpact-bc1.config.ts" -Script "scripts/benchmark/benchmark-gpact-prod.ts" -ExtraEnv $rq1cEnv -Checkpoint "gpact-rq1c-ckpt.json"
Add-ResultRow -Experiment "1c" -Protocol "IntegrateX" -Scenario "EVM+WASM+Fabric" -Output "N/A" -Status "unsupported"

"" | Add-Content -Path $ResultsPath -Encoding UTF8
"Completed: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")" | Add-Content -Path $ResultsPath -Encoding UTF8
Write-Host "All benchmarks completed. Results: $ResultsPath"
