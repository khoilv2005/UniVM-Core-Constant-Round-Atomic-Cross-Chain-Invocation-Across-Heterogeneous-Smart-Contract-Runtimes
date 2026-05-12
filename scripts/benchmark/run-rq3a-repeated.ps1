param(
  [ValidateSet("xsmart", "integratex", "gpact", "atom")]
  [string]$Protocol = "xsmart",
  [int]$Depth = 3,
  [int]$Windows = 5,
  [int]$WarmupSeconds = 300,
  [int]$MeasureSeconds = 600,
  [int]$MaxInFlight = 1
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Relayer = Join-Path $Root "relayer\relayer.exe"
$LogDir = Join-Path $Root "benchmark-results\rq3\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$configByProtocol = @{
  xsmart = "hardhat.xsmart-bc1.config.ts"
  integratex = "hardhat.integratex-bc1.config.ts"
  gpact = "hardhat.gpact-bc1.config.ts"
  atom = "hardhat.atom-bc1.config.ts"
}

$relayerConfigByProtocol = @{
  xsmart = "configs\relayer\config-xsmart-1b-d$Depth.yaml"
  integratex = "configs\relayer\config-integratex-1b-d$Depth.yaml"
  gpact = "configs\relayer\config-gpact-1b-d$Depth.yaml"
  atom = "configs\relayer\config-atom-1b-d$Depth.yaml"
}

$progressLog = Join-Path $LogDir ("rq3a-repeated-{0}-d{1}-{2}.log" -f $Protocol, $Depth, $RunStamp)
"[RQ3a-repeated] started_at=$((Get-Date).ToString('o')) protocol=$Protocol depth=$Depth windows=$Windows warmup=$WarmupSeconds measure=$MeasureSeconds maxInFlight=$MaxInFlight" |
  Tee-Object -FilePath $progressLog -Append

for ($i = 1; $i -le $Windows; $i++) {
  $env:PROTOCOL = $Protocol
  $env:DEPTH = "$Depth"
  $env:WARMUP_SECONDS = "$WarmupSeconds"
  $env:MEASURE_SECONDS = "$MeasureSeconds"
  $env:MAX_IN_FLIGHT = "$MaxInFlight"
  $env:OUT = Join-Path $Root ("benchmark-results/rq3/throughput-{0}-d{1}-window{2}-{3}.json" -f $Protocol, $Depth, $i, $RunStamp)
  $relayerConfig = Join-Path $Root $relayerConfigByProtocol[$Protocol]
  $windowCheckpoint = "./var/rq3a-repeated-$Protocol-d$Depth-window$i-$RunStamp.json"
  $windowConfig = Join-Path $Root ("configs/relayer/config-$Protocol-rq3a-repeated-d$Depth-window$i-$RunStamp.yaml")
  $configText = Get-Content $relayerConfig -Raw
  if ($configText -match 'checkpoint_file:\s*"[^"]+"') {
    $configText = $configText -replace 'checkpoint_file:\s*"[^"]+"', "checkpoint_file: `"$windowCheckpoint`""
  } else {
    $configText = $configText -replace '(?m)^(\s*private_key:\s*"[^"]+"\s*)$', "`$1`n  checkpoint_file: `"$windowCheckpoint`""
  }
  Set-Content -Path $windowConfig -Value $configText -Encoding UTF8
  $windowLog = Join-Path $LogDir ("rq3a-repeated-{0}-d{1}-window{2}-{3}.out.log" -f $Protocol, $Depth, $i, $RunStamp)
  $relayerOut = Join-Path $LogDir ("rq3a-repeated-{0}-d{1}-window{2}-{3}.relayer.out.log" -f $Protocol, $Depth, $i, $RunStamp)
  $relayerErr = Join-Path $LogDir ("rq3a-repeated-{0}-d{1}-window{2}-{3}.relayer.err.log" -f $Protocol, $Depth, $i, $RunStamp)
  "[RQ3a-repeated] window_start=$i/$Windows time=$((Get-Date).ToString('o')) out=$env:OUT config=$relayerConfig" |
    Tee-Object -FilePath $progressLog -Append

  Get-Process | Where-Object { $_.ProcessName -like "*relayer*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  $relayerProcess = Start-Process -FilePath $Relayer -ArgumentList "start", "--config", $windowConfig -PassThru -WindowStyle Hidden -RedirectStandardOutput $relayerOut -RedirectStandardError $relayerErr
  try {
    Start-Sleep -Seconds 5
    npx hardhat run --config $configByProtocol[$Protocol] scripts/benchmark/rq3-throughput.ts --network besu 2>&1 |
      Tee-Object -FilePath $windowLog -Append
    if ($LASTEXITCODE -ne 0) {
      throw "benchmark failed for $Protocol d=$Depth window=$i exit=$LASTEXITCODE"
    }
    $json = Get-Content $env:OUT -Raw | ConvertFrom-Json
    "[RQ3a-repeated] window_done=$i/$Windows submitted=$($json.summary.submitted) completed=$($json.summary.completed) throughputPerMinute=$($json.summary.throughputCompletedPerMinute) time=$((Get-Date).ToString('o'))" |
      Tee-Object -FilePath $progressLog -Append
  } finally {
    if ($relayerProcess -and -not $relayerProcess.HasExited) {
      Stop-Process -Id $relayerProcess.Id -Force
    }
    Start-Sleep -Seconds 5
  }
}

node scripts/benchmark/summarize-ci.js | Tee-Object -FilePath $progressLog -Append
"[RQ3a-repeated] completed_at=$((Get-Date).ToString('o'))" |
  Tee-Object -FilePath $progressLog -Append
