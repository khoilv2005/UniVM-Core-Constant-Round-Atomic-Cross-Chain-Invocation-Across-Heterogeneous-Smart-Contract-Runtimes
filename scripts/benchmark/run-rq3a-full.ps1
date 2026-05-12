$ErrorActionPreference = "Stop"

$Repo = "D:\UIT\randomly"
$Relayer = Join-Path $Repo "relayer\relayer.exe"
$LogDir = Join-Path $Repo "benchmark-results\rq3\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$WarmupSeconds = if ($env:WARMUP_SECONDS) { $env:WARMUP_SECONDS } else { "300" }
$MeasureSeconds = if ($env:MEASURE_SECONDS) { $env:MEASURE_SECONDS } else { "600" }
$DrainTimeoutSeconds = if ($env:DRAIN_TIMEOUT_SECONDS) { $env:DRAIN_TIMEOUT_SECONDS } else { "360" }
$PollIntervalMs = if ($env:POLL_INTERVAL_MS) { $env:POLL_INTERVAL_MS } else { "250" }
$MaxInFlight = if ($env:MAX_IN_FLIGHT) { $env:MAX_IN_FLIGHT } else { "1" }
$SubmitGapMs = if ($env:SUBMIT_GAP_MS) { $env:SUBMIT_GAP_MS } else { "0" }

$jobs = @()
foreach ($depth in @(2, 3, 4, 5)) {
  $jobs += @{ Protocol = "xsmart"; Depth = $depth; Config = "configs\relayer\config-xsmart-1b-d$depth.yaml"; Hardhat = "hardhat.xsmart-bc1.config.ts" }
  $jobs += @{ Protocol = "integratex"; Depth = $depth; Config = "configs\relayer\config-integratex-1b-d$depth.yaml"; Hardhat = "hardhat.integratex-bc1.config.ts" }
  $jobs += @{ Protocol = "gpact"; Depth = $depth; Config = "configs\relayer\config-gpact-1b-d$depth.yaml"; Hardhat = "hardhat.gpact-bc1.config.ts" }
  $jobs += @{ Protocol = "atom"; Depth = $depth; Config = "configs\relayer\config-atom-1b-d$depth.yaml"; Hardhat = "hardhat.atom-bc1.config.ts" }
}

Set-Location $Repo
$startedAt = Get-Date
$progressLog = Join-Path $LogDir "rq3a-full-progress.log"
"[RQ3a-full] started_at=$($startedAt.ToString('o')) jobs=$($jobs.Count) warmup=$WarmupSeconds measure=$MeasureSeconds maxInFlight=$MaxInFlight" |
  Tee-Object -FilePath $progressLog -Append

foreach ($job in $jobs) {
  $protocol = $job.Protocol
  $depth = [int]$job.Depth
  $configPath = Join-Path $Repo $job.Config
  $hardhatConfig = $job.Hardhat
  $jobName = "$protocol-d$depth"
  $jobLog = Join-Path $LogDir "rq3a-$jobName.log"

  "[RQ3a-full] job_start=$jobName time=$((Get-Date).ToString('o'))" |
    Tee-Object -FilePath $progressLog -Append
  Get-Process | Where-Object { $_.ProcessName -like "*relayer*" } | Stop-Process -Force -ErrorAction SilentlyContinue

  $env:PROTOCOL = $protocol
  $env:DEPTH = "$depth"
  $env:WARMUP_SECONDS = "$WarmupSeconds"
  $env:MEASURE_SECONDS = "$MeasureSeconds"
  $env:DRAIN_TIMEOUT_SECONDS = "$DrainTimeoutSeconds"
  $env:POLL_INTERVAL_MS = "$PollIntervalMs"
  $env:MAX_IN_FLIGHT = "$MaxInFlight"
  $env:SUBMIT_GAP_MS = "$SubmitGapMs"
  Remove-Item Env:DRY_RUN -ErrorAction SilentlyContinue

  $relayerProcess = Start-Process -FilePath $Relayer -ArgumentList "start", "--config", $configPath -PassThru -WindowStyle Hidden
  try {
    Start-Sleep -Seconds 5
    "==== RQ3a $jobName ====" | Tee-Object -FilePath $jobLog -Append
    npx hardhat run --config $hardhatConfig scripts/benchmark/rq3-throughput.ts --network besu 2>&1 |
      Tee-Object -FilePath $jobLog -Append
    if ($LASTEXITCODE -ne 0) {
      throw "benchmark failed for $jobName exit=$LASTEXITCODE"
    }

    $jsonPath = Join-Path $Repo "benchmark-results\rq3\throughput-$protocol-d$depth.json"
    $json = Get-Content $jsonPath -Raw | ConvertFrom-Json
    $summaryLine = "[RQ3a-full] job_done=$jobName submitted=$($json.summary.submitted) completed=$($json.summary.completed) measurementCompletions=$($json.summary.measurementCompletions) throughputPerMinute=$($json.summary.throughputCompletedPerMinute) time=$((Get-Date).ToString('o'))"
    $summaryLine | Tee-Object -FilePath $progressLog -Append
  } catch {
    "[RQ3a-full] job_failed=$jobName error=$($_.Exception.Message) time=$((Get-Date).ToString('o'))" |
      Tee-Object -FilePath $progressLog -Append
    throw
  } finally {
    if ($relayerProcess -and -not $relayerProcess.HasExited) {
      Stop-Process -Id $relayerProcess.Id -Force
    }
    Start-Sleep -Seconds 5
  }
}

"[RQ3a-full] completed_at=$((Get-Date).ToString('o')) elapsed_seconds=$([int]((Get-Date) - $startedAt).TotalSeconds)" |
  Tee-Object -FilePath $progressLog -Append
