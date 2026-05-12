param(
  [int[]]$Concurrencies = @(1, 2, 4, 6, 8, 10),
  [int]$Depth = 3,
  [int]$TimeoutSeconds = 420,
  [int]$PollIntervalMs = 250,
  [int]$RelayerWarmupSeconds = 5
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ResultDir = Join-Path $Root "benchmark-results\rq3"
$LogDir = Join-Path $ResultDir "logs"
New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Relayer = Join-Path $Root "relayer\relayer.exe"
if (!(Test-Path $Relayer)) {
  throw "Missing relayer binary: $Relayer"
}

$ProtocolConfigs = @{
  xsmart     = @{
    hardhat = "hardhat.xsmart-bc1.config.ts"
    relayer = "configs\relayer\config-xsmart-1b-d$Depth.yaml"
  }
  integratex = @{
    hardhat = "hardhat.integratex-bc1.config.ts"
    relayer = "configs\relayer\config-integratex-1b-d$Depth.yaml"
  }
  atom       = @{
    hardhat = "hardhat.atom-bc1.config.ts"
    relayer = "configs\relayer\config-atom-1b-d$Depth.yaml"
  }
  gpact      = @{
    hardhat = "hardhat.gpact-bc1.config.ts"
    relayer = "configs\relayer\config-gpact-1b-d$Depth.yaml"
  }
}

$Protocols = @("xsmart", "integratex", "atom", "gpact")
$started = Get-Date
$Progress = Join-Path $LogDir "rq3c-full-progress.log"
$startLine = "[RQ3c-full] started_at=$($started.ToString("o")) depth=$Depth concurrencies=$($Concurrencies -join ',') jobs=$($Protocols.Count * $Concurrencies.Count)"
if (Test-Path $Progress) {
  Add-Content -Path $Progress -Value "[RQ3c-full] resume_at=$($started.ToString("o")) depth=$Depth concurrencies=$($Concurrencies -join ',')"
} else {
  Set-Content -Path $Progress -Value $startLine
}

function Stop-Relayer {
  param($Process)
  if ($null -ne $Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

foreach ($concurrency in $Concurrencies) {
  foreach ($protocol in $Protocols) {
    $cfg = $ProtocolConfigs[$protocol]
    $hardhatConfig = Join-Path $Root $cfg.hardhat
    $relayerConfig = Join-Path $Root $cfg.relayer
    if (!(Test-Path $hardhatConfig)) {
      throw "Missing Hardhat config for ${protocol}: $hardhatConfig"
    }
    if (!(Test-Path $relayerConfig)) {
      throw "Missing relayer config for ${protocol}: $relayerConfig"
    }

    $job = "${protocol}-d${Depth}-c${concurrency}"
    $log = Join-Path $LogDir "rq3c-$job.log"
    $resultPath = Join-Path $ResultDir "concurrency-$protocol-d$Depth-c$concurrency.json"
    if ((Test-Path $resultPath) -and ($env:FORCE_RQ3C -ne "1")) {
      $json = Get-Content $resultPath -Raw | ConvertFrom-Json
      Add-Content -Path $Progress -Value "[RQ3c-full] job_skip=$job completed=$($json.summary.completed) rolledBack=$($json.summary.rolledBack) timedOut=$($json.summary.timedOut) successRate=$($json.summary.successRate) medianLatency=$($json.summary.medianCompletionLatencySeconds) time=$((Get-Date).ToString("o"))"
      continue
    }
    Add-Content -Path $Progress -Value "[RQ3c-full] job_start=$job time=$((Get-Date).ToString("o"))"

    $relayerProcess = $null
    try {
      $relayerProcess = Start-Process -FilePath $Relayer `
        -ArgumentList "start", "--config", $relayerConfig `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "rq3c-$job-relayer.out.log") `
        -RedirectStandardError (Join-Path $LogDir "rq3c-$job-relayer.err.log")
      Start-Sleep -Seconds $RelayerWarmupSeconds

      $env:PROTOCOL = $protocol
      $env:DEPTH = "$Depth"
      $env:CONCURRENCY = "$concurrency"
      $env:TIMEOUT = "$TimeoutSeconds"
      $env:POLL_INTERVAL_MS = "$PollIntervalMs"
      $env:RPC_ACTION_TIMEOUT_MS = "120000"

      npx hardhat run --config $hardhatConfig scripts/benchmark/rq3-concurrency.ts --network besu *>&1 |
        Tee-Object -FilePath $log

      if ($LASTEXITCODE -ne 0) {
        throw "RQ3c job failed: $job exit=$LASTEXITCODE"
      }

      if (Test-Path $resultPath) {
        $json = Get-Content $resultPath -Raw | ConvertFrom-Json
        Add-Content -Path $Progress -Value "[RQ3c-full] job_done=$job completed=$($json.summary.completed) rolledBack=$($json.summary.rolledBack) timedOut=$($json.summary.timedOut) successRate=$($json.summary.successRate) medianLatency=$($json.summary.medianCompletionLatencySeconds) time=$((Get-Date).ToString("o"))"
      } else {
        Add-Content -Path $Progress -Value "[RQ3c-full] job_done=$job result_missing=true time=$((Get-Date).ToString("o"))"
      }
    } finally {
      Stop-Relayer $relayerProcess
      Remove-Item Env:PROTOCOL -ErrorAction SilentlyContinue
      Remove-Item Env:DEPTH -ErrorAction SilentlyContinue
      Remove-Item Env:CONCURRENCY -ErrorAction SilentlyContinue
      Remove-Item Env:TIMEOUT -ErrorAction SilentlyContinue
      Remove-Item Env:POLL_INTERVAL_MS -ErrorAction SilentlyContinue
      Remove-Item Env:RPC_ACTION_TIMEOUT_MS -ErrorAction SilentlyContinue
    }
  }
}

$ended = Get-Date
$elapsed = [int]($ended - $started).TotalSeconds
Add-Content -Path $Progress -Value "[RQ3c-full] completed_at=$($ended.ToString("o")) elapsed_seconds=$elapsed"
