/**
 * XSmart RQ1a benchmark - representative 2-chain homogeneous-EVM workflow.
 *
 * IMPORTANT:
 * - This benchmark uses a fixed representative workload:
 *   [sHotel(bc2-evm), sTrain(bc3-evm)].
 * - Therefore XSmart 1a is closer to XSmart 1b d=3 than to XSmart 1b d=2.
 * - RQ1a and RQ1b d=2 must not be compared as if they were the same workload.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Sample = {
  run: number;
  txId: string;
  startBlock: number;
  finalBlock: number;
  latencySeconds: number;
  latencyMs: number;
  blockLatencySeconds: number;
  depth: number;
};

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase()];
  if (envValue && envValue.trim() !== "") {
    return envValue;
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return defaultValue;
}

function loadDeployment(name: string) {
  const filePath = path.join(__dirname, "..", "..", "deployments", "xsmart", `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    contracts: Record<string, string>;
  };
}

async function blockTimestamp(blockNumber: number): Promise<number> {
  const block = await ethers.provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
}

async function executionInactive(bridgeAddress: string, txId: bigint): Promise<boolean> {
  const bridgeRead = await ethers.getContractAt(
    [
      "function activeExecutions(uint256) view returns (address initiator, uint256 startBlock, uint256 timeoutBlocks, uint256 updateAckCount, bool active)",
    ],
    bridgeAddress,
  );
  const execution = await bridgeRead.activeExecutions(txId);
  return execution.active === false;
}

async function ensureTranslatedBenchmarkState(translatedAddress: string) {
  const translated = await ethers.getContractAt("HotelBookingTranslated", translatedAddress);
  const price = await translated.GetPrice();
  if (price !== 0n) {
    return;
  }
  const metaSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "META"],
  );
  const metaPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "uint256", "uint256"],
    ["benchmark", 100n, 2000n, 1n],
  );
  await (await translated.__vassp_apply(metaSlot, metaPayload)).wait();
}

async function findCompletionBlock(
  bridge: Awaited<ReturnType<typeof ethers.getContractAt>>,
  txId: bigint,
  fromBlock: number,
  toBlock?: number,
): Promise<number | null> {
  const latestBlock = toBlock ?? (await ethers.provider.getBlockNumber());
  const filter = bridge.filters.ExecutionCompleted(txId);
  const events = await bridge.queryFilter(filter, fromBlock, latestBlock);
  if (events.length === 0) {
    return null;
  }
  return events[events.length - 1].blockNumber;
}

function summarize(samples: Sample[]) {
  const latenciesMs = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const latenciesSeconds = latenciesMs.map((value) => value / 1000);
  const sum = latenciesMs.reduce((total, value) => total + value, 0);
  const avg = latenciesMs.length > 0 ? sum / latenciesMs.length : 0;
  const median =
    latenciesMs.length === 0
      ? 0
      : latenciesMs.length % 2 === 1
        ? latenciesMs[(latenciesMs.length - 1) / 2]
        : (latenciesMs[latenciesMs.length / 2 - 1] + latenciesMs[latenciesMs.length / 2]) / 2;
  const variance =
    latenciesMs.length === 0
      ? 0
      : latenciesMs.reduce((total, value) => total + (value - avg) ** 2, 0) / latenciesMs.length;
  const stdMs = Math.sqrt(variance);

  return {
    runs: samples.length,
    minMs: latenciesMs[0] ?? 0,
    maxMs: latenciesMs[latenciesMs.length - 1] ?? 0,
    avgMs: avg,
    medianMs: median,
    stdMs,
    minSeconds: latenciesSeconds[0] ?? 0,
    maxSeconds: latenciesSeconds[latenciesSeconds.length - 1] ?? 0,
    avgSeconds: avg / 1000,
    medianSeconds: median / 1000,
    stdSeconds: stdMs / 1000,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const code = (error as { code?: string }).code;
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "NONCE_EXPIRED" ||
    code === "REPLACEMENT_UNDERPRICED" ||
    message.includes("headers timeout") ||
    message.includes("replacement transaction underpriced") ||
    message.includes("replacement fee too low") ||
    message.includes("nonce too low") ||
    message.includes("already known") ||
    message.includes("socket hang up") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("temporarily unavailable")
  );
}

async function withRetry<T>(label: string, action: () => Promise<T>, attempts = 5, delayMs = 3000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[XSmart-1A][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`XSmart 1a benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "30"));
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const runDelayMs = Number(getArg("run-delay-ms", "3000"));
  const settleDelayMs = Number(getArg("settle-delay-ms", "2000"));
  const representativeDepth = 3;

  const deploymentBc1 = loadDeployment("bc1-1a");
  const deploymentBc2 = loadDeployment("bc2-evm");
  const deploymentBc3 = loadDeployment("bc3-evm");

  const bridge = await ethers.getContractAt("XBridgingContract", deploymentBc1.contracts.xBridgingContract);
  await ensureTranslatedBenchmarkState(deploymentBc1.contracts.hotelBookingTranslated);
  // Representative 2-chain workload: bc2 + bc3. This is closer to 1b d=3 than 1b d=2.
  const stateContracts = [deploymentBc2.contracts.sHotel, deploymentBc3.contracts.sTrain];

  if (stateContracts.some((value) => !value)) {
    throw new Error("XSmart 1a requires deployments/xsmart/bc1-1a.json, bc2-evm.json and bc3-evm.json");
  }

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const txId = BigInt(Date.now()) * 1000n + BigInt(run);
    const submitAtMs = Date.now();

    const fee = await withRetry(`[run=${run}] crossChainFee`, () => bridge.crossChainFee());
    const tx = await withRetry(`[run=${run}] requestLockStates`, () =>
      bridge.requestLockStates(txId, "travel", stateContracts, 30n, 2n, { value: fee }),
    );
    const receipt = await withRetry(`[run=${run}] wait requestLockStates`, () => tx.wait());
    const startBlock = receipt!.blockNumber;
    const startTimestamp = await withRetry(`[run=${run}] start block timestamp`, () => blockTimestamp(startBlock));
    await sleep(settleDelayMs);

    const startedAt = Date.now();
    let finalBlock = 0;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      const latestBlock = await withRetry(`[run=${run}] latest block`, () => ethers.provider.getBlockNumber());
      const completionBlock = await withRetry(`[run=${run}] completion block`, () =>
        findCompletionBlock(bridge, txId, startBlock, latestBlock),
      );
      if (completionBlock !== null) {
        finalBlock = completionBlock;
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (finalBlock === 0) {
      throw new Error(`XSmart 1a txId=${txId} did not complete within ${timeoutSeconds}s`);
    }

    const inactive = await withRetry(`[run=${run}] execution inactive`, async () =>
      executionInactive(await bridge.getAddress(), txId),
    );
    if (!inactive) {
      throw new Error(`XSmart 1a txId=${txId} emitted ExecutionCompleted but execution remains active`);
    }

    const finalTimestamp = await withRetry(`[run=${run}] final block timestamp`, () => blockTimestamp(finalBlock));
    const latencyMs = Date.now() - submitAtMs;
    const sample: Sample = {
      run,
      txId: txId.toString(),
      startBlock,
      finalBlock,
      latencySeconds: latencyMs / 1000,
      latencyMs,
      blockLatencySeconds: finalTimestamp - startTimestamp,
      depth: representativeDepth,
    };
    samples.push(sample);
    console.log(
      `[XSmart-1A][run=${run}] txId=${txId} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`,
    );

    await sleep(runDelayMs);
  }

  const result = {
    protocol: "xsmart",
    mode: "live-e2e-homogeneous-evm",
    workloadAxis: "service-depth-2-chain-representative",
    note: "RQ1a uses fixed [sHotel(bc2-evm), sTrain(bc3-evm)] and is closer to RQ1b d=3 than RQ1b d=2",
    summary: summarize(samples),
    samples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "xsmart-1a.json");
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
