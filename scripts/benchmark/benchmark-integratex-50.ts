import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Sample = {
  run: number;
  txId: number;
  startBlock: number;
  finalBlock: number;
  latencySeconds: number;
  latencyMs: number;
  blockLatencySeconds: number;
  finalStatus: number;
};

function loadDeployment(chain: string) {
  const filePath = path.join(__dirname, "..", "..", "deployments", "integratex", `${chain}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    contracts: Record<string, string>;
  };
}

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

async function blockTimestamp(blockNumber: number): Promise<number> {
  const block = await ethers.provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
}

async function findCompletionBlock(
  travelDApp: Awaited<ReturnType<typeof ethers.getContractAt>>,
  txId: number,
  fromBlock: number,
  toBlock?: number,
): Promise<number | null> {
  const latestBlock = toBlock ?? (await ethers.provider.getBlockNumber());
  const filter = travelDApp.filters.CrossChainExecutionCompleted(txId);
  const events = await travelDApp.queryFilter(filter, fromBlock, latestBlock);
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

  return {
    runs: samples.length,
    minMs: latenciesMs[0] ?? 0,
    maxMs: latenciesMs[latenciesMs.length - 1] ?? 0,
    avgMs: avg,
    medianMs: median,
    minSeconds: latenciesSeconds[0] ?? 0,
    maxSeconds: latenciesSeconds[latenciesSeconds.length - 1] ?? 0,
    avgSeconds: avg / 1000,
    medianSeconds: median / 1000,
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
    message.includes("headers timeout") ||
    message.includes("replacement transaction underpriced") ||
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
      console.log(`[IntegrateX][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`IntegrateX benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "50"));
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const settleDelayMs = Number(getArg("settle-delay-ms", "2000"));
  const runDelayMs = Number(getArg("run-delay-ms", "3000"));
  const deploymentBc1 = loadDeployment("bc1");
  const deploymentBc2 = loadDeployment("bc2");
  const deploymentBc3 = loadDeployment("bc3");
  const travelDApp = await ethers.getContractAt("CrossChainTravelDApp", deploymentBc1.contracts.travelDApp);
  const stateContracts = [deploymentBc2.contracts.sHotel, deploymentBc3.contracts.sTrain];
  const chainIds = [2, 3];

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const initiateTx = await withRetry(`run=${run} initiateExecution`, () => travelDApp.initiateExecution(1, 1, 1));
    await withRetry(`run=${run} wait initiateExecution`, () => initiateTx.wait());
    const txId = Number(await withRetry(`run=${run} executionCount`, () => travelDApp.executionCount()));

    const submitAtMs = Date.now();
    const lockTx = await withRetry(`run=${run} startLocking`, () => travelDApp.startLocking(txId, stateContracts, chainIds));
    const lockReceipt = await withRetry(`run=${run} wait startLocking`, () => lockTx.wait());
    const startBlock = lockReceipt!.blockNumber;
    const startTimestamp = await withRetry(`run=${run} start block timestamp`, () => blockTimestamp(startBlock));
    await sleep(settleDelayMs);

    const startedAt = Date.now();
    let finalStatus = Number(await withRetry(`run=${run} initial status`, () => travelDApp.getExecutionStatus(txId)));
    let finalBlock = startBlock;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      finalStatus = Number(await withRetry(`run=${run} poll status`, () => travelDApp.getExecutionStatus(txId)));
      if (finalStatus === 7 || finalStatus === 8) {
        const latestBlock = await withRetry(`run=${run} latest block number`, () => ethers.provider.getBlockNumber());
        const completionBlock = await withRetry(
          `run=${run} completion event block`,
          () => findCompletionBlock(travelDApp, txId, startBlock, latestBlock),
        );
        finalBlock = completionBlock ?? latestBlock;
        finalObservedAtMs = Date.now();
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (finalStatus !== 7 && finalStatus !== 8) {
      throw new Error(`IntegrateX txId=${txId} did not complete within ${timeoutSeconds}s`);
    }

    const finalTimestamp = await withRetry(`run=${run} final block timestamp`, () => blockTimestamp(finalBlock));
    const latencyMs = finalObservedAtMs - submitAtMs;
    const sample: Sample = {
      run,
      txId,
      startBlock,
      finalBlock,
      latencySeconds: latencyMs / 1000,
      latencyMs,
      blockLatencySeconds: finalTimestamp - startTimestamp,
      finalStatus,
    };
    samples.push(sample);
    console.log(
      `[IntegrateX][run=${run}] txId=${txId} status=${finalStatus} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`,
    );
    await sleep(runDelayMs);
  }

  const result = {
    protocol: "integratex",
    mode: "live-e2e",
    summary: summarize(samples),
    samples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "integratex-50.json");
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
