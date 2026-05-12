$ErrorActionPreference = "Stop"

$Repo = "D:\UIT\randomly"
$Relayer = Join-Path $Repo "relayer\relayer.exe"
$LogDir = Join-Path $Repo "benchmark-results\rq3\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$jobs = @()
foreach ($depth in @(2, 3, 4)) {
  $jobs += @{ Protocol = "xsmart"; Depth = $depth; Config = "configs\relayer\config-xsmart-1b-d$depth.yaml"; Hardhat = "hardhat.xsmart-bc1.config.ts" }
  $jobs += @{ Protocol = "integratex"; Depth = $depth; Config = "configs\relayer\config-integratex-1b-d$depth.yaml"; Hardhat = "hardhat.integratex-bc1.config.ts" }
  $jobs += @{ Protocol = "gpact"; Depth = $depth; Config = "configs\relayer\config-gpact-1b-d$depth.yaml"; Hardhat = "hardhat.gpact-bc1.config.ts" }
  $jobs += @{ Protocol = "atom"; Depth = $depth; Config = "configs\relayer\config-atom-1b-d$depth.yaml"; Hardhat = "hardhat.atom-bc1.config.ts" }
}

Set-Location $Repo
$startedAt = Get-Date
"[RQ3b-full30] started_at=$($startedAt.ToString('o')) jobs=$($jobs.Count)" | Tee-Object -FilePath (Join-Path $LogDir "full30-progress.log") -Append

foreach ($job in $jobs) {
  $protocol = $job.Protocol
  $depth = [int]$job.Depth
  $configPath = Join-Path $Repo $job.Config
  $hardhatConfig = $job.Hardhat
  $jobName = "$protocol-d$depth"
  $jobLog = Join-Path $LogDir "$jobName.log"

  "[RQ3b-full30] job_start=$jobName time=$((Get-Date).ToString('o'))" | Tee-Object -FilePath (Join-Path $LogDir "full30-progress.log") -Append
  Get-Process | Where-Object { $_.ProcessName -like "*relayer*" } | Stop-Process -Force -ErrorAction SilentlyContinue

  $env:PROTOCOL = $protocol
  $env:DEPTH = "$depth"
  $env:RUNS = "30"
  $env:TIMEOUT = "360"
  $env:POLL_INTERVAL_MS = "250"
  $env:RUN_DELAY_MS = "3000"
  $env:SCAN_MARGIN_SECONDS = "15"
  Remove-Item Env:DRY_RUN -ErrorAction SilentlyContinue

  $relayerProcess = Start-Process -FilePath $Relayer -ArgumentList "start", "--config", $configPath -PassThru -WindowStyle Hidden
  try {
    Start-Sleep -Seconds 5
    "==== $jobName ====" | Tee-Object -FilePath $jobLog -Append
    npx hardhat run --config $hardhatConfig scripts/benchmark/rq3-gas.ts --network besu 2>&1 | Tee-Object -FilePath $jobLog -Append
    if ($LASTEXITCODE -ne 0) {
      throw "benchmark failed for $jobName exit=$LASTEXITCODE"
    }

    $jsonPath = Join-Path $Repo "benchmark-results\rq3\gas-$protocol-d$depth.json"
    $json = Get-Content $jsonPath -Raw | ConvertFrom-Json
    $paper = $json.summary.avgPaperCategoryGas
    $summaryLine = "[RQ3b-full30] job_done=$jobName total=$($json.summary.avgTotalGas) bridge=$($paper.bridge_gas) state=$($paper.state_lock_unlock_gas) integrated=$($paper.integrated_execution_gas) time=$((Get-Date).ToString('o'))"
    $summaryLine | Tee-Object -FilePath (Join-Path $LogDir "full30-progress.log") -Append
  } catch {
    "[RQ3b-full30] job_failed=$jobName error=$($_.Exception.Message) time=$((Get-Date).ToString('o'))" | Tee-Object -FilePath (Join-Path $LogDir "full30-progress.log") -Append
    throw
  } finally {
    if ($relayerProcess -and -not $relayerProcess.HasExited) {
      Stop-Process -Id $relayerProcess.Id -Force
    }
    Start-Sleep -Seconds 5
  }
}

"[RQ3b-full30] completed_at=$((Get-Date).ToString('o')) elapsed_seconds=$([int]((Get-Date) - $startedAt).TotalSeconds)" | Tee-Object -FilePath (Join-Path $LogDir "full30-progress.log") -Append
