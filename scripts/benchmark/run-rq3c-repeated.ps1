param(
  [ValidateSet("xsmart", "integratex", "atom", "gpact")]
  [string[]]$Protocols = @("xsmart", "integratex", "atom", "gpact"),
  [int[]]$Concurrencies = @(10),
  [int]$Depth = 3,
  [int]$Repeats = 5,
  [int]$TimeoutSeconds = 420,
  [int]$PollIntervalMs = 250,
  [int]$RelayerWarmupSeconds = 5
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ResultDir = Join-Path $Root "benchmark-results\rq3\repeated"
$LogDir = Join-Path $Root "benchmark-results\rq3\logs"
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

function Stop-Relayer {
  param($Process)
  if ($null -ne $Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

function Set-WindowCheckpoint {
  param(
    [string]$Protocol,
    [int]$Concurrency,
    [int]$Repeat,
    [string]$RunStamp,
    [string]$SourceConfig
  )
  $windowCheckpoint = "./var/rq3c-repeated-$Protocol-d$Depth-c$Concurrency-r$Repeat-$RunStamp.json"
  $windowConfig = Join-Path $Root ("configs/relayer/config-$Protocol-rq3c-repeated-d$Depth-c$Concurrency-r$Repeat-$RunStamp.yaml")
  $configText = Get-Content $SourceConfig -Raw
  if ($configText -match 'checkpoint_file:\s*"[^"]+"') {
    $configText = $configText -replace 'checkpoint_file:\s*"[^"]+"', "checkpoint_file: `"$windowCheckpoint`""
  } else {
    $configText = $configText -replace '(?m)^(\s*private_key:\s*"[^"]+"\s*)$', "`$1`n  checkpoint_file: `"$windowCheckpoint`""
  }
  Set-Content -Path $windowConfig -Value $configText -Encoding UTF8
  return $windowConfig
}

$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Progress = Join-Path $LogDir "rq3c-repeated-$RunStamp.log"
Add-Content -Path $Progress -Value "[RQ3c-repeated] started_at=$((Get-Date).ToString("o")) depth=$Depth concurrencies=$($Concurrencies -join ',') repeats=$Repeats protocols=$($Protocols -join ',')"

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

    for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
      $job = "$protocol-d$Depth-c$concurrency-r$repeat-$RunStamp"
      $resultPath = Join-Path $ResultDir "concurrency-$job.json"
      $log = Join-Path $LogDir "rq3c-repeated-$job.log"
      $relayerOut = Join-Path $LogDir "rq3c-repeated-$job-relayer.out.log"
      $relayerErr = Join-Path $LogDir "rq3c-repeated-$job-relayer.err.log"
      Add-Content -Path $Progress -Value "[RQ3c-repeated] job_start=$job time=$((Get-Date).ToString("o"))"

      $windowConfig = Set-WindowCheckpoint -Protocol $protocol -Concurrency $concurrency -Repeat $repeat -RunStamp $RunStamp -SourceConfig $relayerConfig
      $relayerProcess = $null
      try {
        Get-Process | Where-Object { $_.ProcessName -like "*relayer*" } | Stop-Process -Force -ErrorAction SilentlyContinue
        $relayerProcess = Start-Process -FilePath $Relayer `
          -ArgumentList "start", "--config", $windowConfig `
          -PassThru -WindowStyle Hidden `
          -RedirectStandardOutput $relayerOut `
          -RedirectStandardError $relayerErr
        Start-Sleep -Seconds $RelayerWarmupSeconds

        $env:PROTOCOL = $protocol
        $env:DEPTH = "$Depth"
        $env:CONCURRENCY = "$concurrency"
        $env:TIMEOUT = "$TimeoutSeconds"
        $env:POLL_INTERVAL_MS = "$PollIntervalMs"
        $env:RPC_ACTION_TIMEOUT_MS = "120000"
        $env:OUT = $resultPath

        npx hardhat run --config $hardhatConfig scripts/benchmark/rq3-concurrency.ts --network besu *>&1 |
          Tee-Object -FilePath $log

        if ($LASTEXITCODE -ne 0) {
          throw "RQ3c repeated job failed: $job exit=$LASTEXITCODE"
        }

        $json = Get-Content $resultPath -Raw | ConvertFrom-Json
        Add-Content -Path $Progress -Value "[RQ3c-repeated] job_done=$job completed=$($json.summary.completed) timedOut=$($json.summary.timedOut) median=$($json.summary.medianCompletionLatencySeconds) p90=$($json.summary.p90CompletionLatencySeconds) p99=$($json.summary.p99CompletionLatencySeconds) time=$((Get-Date).ToString("o"))"
      } finally {
        Stop-Relayer $relayerProcess
        Remove-Item Env:PROTOCOL -ErrorAction SilentlyContinue
        Remove-Item Env:DEPTH -ErrorAction SilentlyContinue
        Remove-Item Env:CONCURRENCY -ErrorAction SilentlyContinue
        Remove-Item Env:TIMEOUT -ErrorAction SilentlyContinue
        Remove-Item Env:POLL_INTERVAL_MS -ErrorAction SilentlyContinue
        Remove-Item Env:RPC_ACTION_TIMEOUT_MS -ErrorAction SilentlyContinue
        Remove-Item Env:OUT -ErrorAction SilentlyContinue
      }
    }
  }
}

Add-Content -Path $Progress -Value "[RQ3c-repeated] completed_at=$((Get-Date).ToString("o"))"
