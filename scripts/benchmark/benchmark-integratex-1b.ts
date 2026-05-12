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
  depth: number;
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

function selected(depth: number, deploymentBc2: ReturnType<typeof loadDeployment>, deploymentBc3: ReturnType<typeof loadDeployment>) {
  const stateContracts: string[] = [];
  const chainIds: number[] = [];
  if (depth >= 2) {
    stateContracts.push(deploymentBc2.contracts.sHotel);
    chainIds.push(2);
  }
  if (depth >= 3) {
    stateContracts.push(deploymentBc3.contracts.sTrain);
    chainIds.push(3);
  }
  if (depth >= 4) {
    stateContracts.push(deploymentBc2.contracts.sFlight);
    chainIds.push(2);
  }
  if (depth >= 5) {
    stateContracts.push(deploymentBc3.contracts.sTaxi);
    chainIds.push(3);
  }
  return { stateContracts, chainIds };
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
      console.log(`[IntegrateX-1B][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`IntegrateX 1b benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "30"));
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const settleDelayMs = Number(getArg("settle-delay-ms", "2000"));
  const runDelayMs = Number(getArg("run-delay-ms", "3000"));
  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`IntegrateX 1b depth must be one of 2,3,4,5; got ${depth}`);
  }

  const deploymentBc1 = loadDeployment("bc1");
  const deploymentBc2 = loadDeployment("bc2");
  const deploymentBc3 = loadDeployment("bc3");
  const travelDApp = await ethers.getContractAt("CrossChainTravelDepthDApp", deploymentBc1.contracts.travelDepthDApp);
  const { stateContracts, chainIds } = selected(depth, deploymentBc2, deploymentBc3);

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const initiateTx = await withRetry(`[depth=${depth}][run=${run}] initiateExecution`, () => travelDApp.initiateExecution(1, 1, 1));
    const initiateReceipt = await withRetry(`[depth=${depth}][run=${run}] wait initiateExecution`, () => initiateTx.wait());
    const initiateEvent = initiateReceipt!.logs
      .map((log) => {
        try {
          return travelDApp.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.name === "CrossChainExecutionInitiated");
    if (!initiateEvent) {
      throw new Error("CrossChainExecutionInitiated event not found");
    }
    const txId = Number(initiateEvent.args.crossChainTxId);

    const submitAtMs = Date.now();
    const lockTx = await withRetry(`[depth=${depth}][run=${run}] startLocking`, () => travelDApp.startLocking(txId, stateContracts, chainIds));
    const lockReceipt = await withRetry(`[depth=${depth}][run=${run}] wait startLocking`, () => lockTx.wait());
    const startBlock = lockReceipt!.blockNumber;
    const startTimestamp = await withRetry(`[depth=${depth}][run=${run}] start block timestamp`, () => blockTimestamp(startBlock));
    await sleep(settleDelayMs);

    const startedAt = Date.now();
    let finalStatus = Number(await withRetry(`[depth=${depth}][run=${run}] initial status`, () => travelDApp.getExecutionStatus(txId)));
    let finalBlock = startBlock;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      finalStatus = Number(await withRetry(`[depth=${depth}][run=${run}] poll status`, () => travelDApp.getExecutionStatus(txId)));
      if (finalStatus === 7 || finalStatus === 8) {
        const latestBlock = await withRetry(`[depth=${depth}][run=${run}] latest block number`, () => ethers.provider.getBlockNumber());
        const completionBlock = await withRetry(
          `[depth=${depth}][run=${run}] completion event block`,
          () => findCompletionBlock(travelDApp, txId, startBlock, latestBlock),
        );
        finalBlock = completionBlock ?? latestBlock;
        finalObservedAtMs = Date.now();
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (finalStatus !== 7 && finalStatus !== 8) {
      throw new Error(`IntegrateX 1b txId=${txId} depth=${depth} did not complete within ${timeoutSeconds}s`);
    }

    const finalTimestamp = await withRetry(`[depth=${depth}][run=${run}] final block timestamp`, () => blockTimestamp(finalBlock));
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
      depth,
    };
    samples.push(sample);
    console.log(
      `[IntegrateX-1B][depth=${depth}][run=${run}] txId=${txId} status=${finalStatus} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`,
    );
    await sleep(runDelayMs);
  }

  const result = {
    protocol: "integratex",
    mode: "live-e2e-1b",
    depth,
    summary: summarize(samples),
    samples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `integratex-1b-d${depth}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
