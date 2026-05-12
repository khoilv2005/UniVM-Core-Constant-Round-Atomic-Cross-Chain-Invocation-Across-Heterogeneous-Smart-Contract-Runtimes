param(
  [int]$Limit = 30,
  [string]$Namespace = ("vm-live30-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$contracts = @(
  @{ Name = "HotelBooking"; Cases = "benchmark-results/rq2/cases/hotel-booking.jsonl" },
  @{ Name = "TrainBooking"; Cases = "benchmark-results/rq2/cases/trainbooking.jsonl" },
  @{ Name = "TokenTransfer"; Cases = "benchmark-results/rq2/cases/tokentransfer.jsonl" },
  @{ Name = "AuctionLogic"; Cases = "benchmark-results/rq2/cases/auctionlogic.jsonl" },
  @{ Name = "DEXSwap"; Cases = "benchmark-results/rq2/cases/dexswap.jsonl" }
)

foreach ($entry in $contracts) {
  $out = Join-Path $Root ("benchmark-results/rq2/results/{0}-vm-live{1}.json" -f $entry.Name, $Limit)
  $failures = Join-Path $Root ("benchmark-results/rq2/results/{0}-vm-live{1}-failures.jsonl" -f $entry.Name, $Limit)
  $cases = Join-Path $Root $entry.Cases
  Write-Host "[RQ2-live] $($entry.Name) limit=$Limit namespace=$Namespace"
  $env:RQ2_CONTRACT = $entry.Name
  $env:RQ2_LIMIT = "$Limit"
  $env:RQ2_CASES = $cases
  $env:RQ2_OUT = $out
  $env:RQ2_FAILURES = $failures
  $env:RQ2_RESUME = "1"
  $env:RQ2_NAMESPACE = $Namespace
  npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/rq2/run-rq2a-vm-full.ts --network besu
}

npx ts-node --project tsconfig.scripts.json scripts/rq2/summarize-rq2-hybrid.ts
