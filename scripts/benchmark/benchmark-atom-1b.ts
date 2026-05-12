import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Sample = {
  run: number;
  invokeId: string;
  startBlock: number;
  finalBlock: number;
  latencySeconds: number;
  latencyMs: number;
  blockLatencySeconds: number;
  finalStatus: number;
  depth: number;
};

type ServiceSpec = {
  name: "hotel" | "train" | "flight" | "taxi";
  chain: "bc2" | "bc3";
  address: string;
  abi: string[];
  unlockEvent: string;
  undoEvent: string;
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

function parseBigIntArg(name: string, defaultValue: string): bigint {
  return BigInt(getArg(name, defaultValue));
}

function loadDeployment(chain: string) {
  const filePath = path.join(__dirname, "..", "..", "deployments", "atom", `${chain}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    contracts: Record<string, string>;
  };
}

function rpcUrlForChain(chain: "bc2" | "bc3"): string {
  const envKey = `${chain.toUpperCase()}_RPC_URL`;
  const envValue = process.env[envKey];
  if (envValue && envValue.trim() !== "") {
    return envValue;
  }
  if (chain === "bc2") {
    return "http://170.64.194.4:8545";
  }
  return "http://170.64.164.173:8545";
}

async function blockTimestamp(provider: ethers.Provider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
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
      console.log(`[Atom-1B][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function latestMatchingEvent(
  contract: ethers.Contract,
  filters: ethers.DeferredTopicFilter[],
  fromBlock: number,
  toBlock: number,
): Promise<ethers.EventLog | null> {
  let latest: ethers.EventLog | null = null;
  for (const filter of filters) {
    const events = await withRetry(
      `[event-scan] ${String(filter.fragment?.name ?? "unknown")} ${fromBlock}-${toBlock}`,
      () => contract.queryFilter(filter, fromBlock, toBlock),
    );
    for (const entry of events) {
      if (!(entry instanceof ethers.EventLog)) {
        continue;
      }
      if (!latest || entry.blockNumber > latest.blockNumber) {
        latest = entry;
      }
    }
  }
  return latest;
}

async function serviceCompletionForSpec(
  invokeId: string,
  startBlock: number,
  spec: ServiceSpec,
  provider: ethers.Provider,
): Promise<{ blockNumber: number; timestamp: number } | null> {
  const contract = new ethers.Contract(spec.address, spec.abi, provider) as ethers.Contract & {
    filters: Record<string, (...args: unknown[]) => ethers.DeferredTopicFilter>;
  };
  const latestBlock = await withRetry(`[${spec.name}] latest block`, () => provider.getBlockNumber());
  const filterA = contract.filters[spec.unlockEvent](invokeId);
  const filterB = contract.filters[spec.undoEvent](invokeId);
  const event = await withRetry(`[${spec.name}] completion scan`, () =>
    latestMatchingEvent(contract, [filterA, filterB], startBlock, latestBlock),
  );
  if (!event) {
    return null;
  }
  const timestamp = await withRetry(`[${spec.name}] block timestamp`, () => blockTimestamp(provider, event.blockNumber));
  return { blockNumber: event.blockNumber, timestamp };
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

function selectedServices(depth: number, bc2: ReturnType<typeof loadDeployment>, bc3: ReturnType<typeof loadDeployment>): ServiceSpec[] {
  const services: ServiceSpec[] = [];
  if (depth >= 2) {
    services.push({
      name: "hotel",
      chain: "bc2",
      address: bc2.contracts.atomHotel,
      abi: [
        "event AtomHotelUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms)",
        "event AtomHotelUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms)",
      ],
      unlockEvent: "AtomHotelUnlocked",
      undoEvent: "AtomHotelUndoUnlocked",
    });
  }
  if (depth >= 3) {
    services.push({
      name: "train",
      chain: "bc3",
      address: bc3.contracts.atomTrain,
      abi: [
        "event AtomTrainUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets)",
        "event AtomTrainUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets)",
      ],
      unlockEvent: "AtomTrainUnlocked",
      undoEvent: "AtomTrainUndoUnlocked",
    });
  }
  if (depth >= 4) {
    services.push({
      name: "flight",
      chain: "bc2",
      address: bc2.contracts.atomFlight,
      abi: [
        "event AtomFlightUnlocked(bytes32 indexed invokeId, address indexed user, uint256 seats)",
        "event AtomFlightUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 seats)",
      ],
      unlockEvent: "AtomFlightUnlocked",
      undoEvent: "AtomFlightUndoUnlocked",
    });
  }
  if (depth >= 5) {
    services.push({
      name: "taxi",
      chain: "bc3",
      address: bc3.contracts.atomTaxi,
      abi: [
        "event AtomTaxiUnlocked(bytes32 indexed invokeId, address indexed user, uint256 cars)",
        "event AtomTaxiUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 cars)",
      ],
      unlockEvent: "AtomTaxiUnlocked",
      undoEvent: "AtomTaxiUndoUnlocked",
    });
  }
  return services;
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`Atom 1b benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "30"));
  const timeoutSeconds = Number(getArg("timeout", "300"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "1000"));
  const invokeGasLimit = parseBigIntArg("invoke-gas-limit", "800000");
  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`Atom 1b depth must be one of 2,3,4,5; got ${depth}`);
  }

  const deploymentBc1 = loadDeployment("bc1");
  const deploymentBc2 = loadDeployment("bc2");
  const deploymentBc3 = loadDeployment("bc3");
  const entryAddress = deploymentBc1.contracts.atomTravelDepthEntry;
  if (!entryAddress) {
    throw new Error("ATOM 1b requires atomTravelDepthEntry on bc1; rerun deploy:atom:bc1");
  }

  const [deployer] = await ethers.getSigners();
  const service = await ethers.getContractAt(
    [
      "function getInvocation(bytes32 invokeId) view returns ((bytes32 invokeId, bytes32 workflowId, address entry, address server, uint256 startedBlock, uint256 serviceDeadlineBlock, uint256 auditDeadlineBlock, uint256 totalOperationCount, uint256 proofCount, uint256 judgeNumNeed, uint256 judgeNumMin, uint256 validVoteCount, uint256 invalidVoteCount, bool proofSubmissionComplete, uint8 status, address[] judges))",
    ],
    deploymentBc1.contracts.atomService,
    deployer,
  );
  const entry = await ethers.getContractAt(
    [
      "function invokeWriteOnlyDepth(bytes32 invokeId, uint256 totalOperationCount, uint256 numRooms, uint256 numOutboundTickets, uint256 numReturnTickets)",
    ],
    entryAddress,
    deployer,
  );

  const hotelProvider = new ethers.JsonRpcProvider(rpcUrlForChain("bc2"));
  const trainProvider = new ethers.JsonRpcProvider(rpcUrlForChain("bc3"));
  const serviceSpecs = selectedServices(depth, deploymentBc2, deploymentBc3);

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`atom-1b-depth-${depth}-${run}-${Date.now()}`));
    const submitAtMs = Date.now();
    const totalOperationCount = BigInt(Math.max(1, depth - 1));
    const tx = await withRetry(`[depth=${depth}][run=${run}] invokeWriteOnlyDepth`, () =>
      entry.invokeWriteOnlyDepth(invokeId, totalOperationCount, 1, 1, 1, { gasLimit: invokeGasLimit }),
    );
    const receipt = await withRetry(`[depth=${depth}][run=${run}] wait invokeWriteOnlyDepth`, () => tx.wait());
    const startBlock = receipt!.blockNumber;
    const startTimestamp = await withRetry(`[depth=${depth}][run=${run}] start block timestamp`, () =>
      blockTimestamp(ethers.provider, startBlock),
    );

    const startedAt = Date.now();
    let finalStatus = 0;
    let finalBlock = startBlock;
    let finalTimestamp = startTimestamp;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      const completions = await Promise.all(
        serviceSpecs.map((spec) =>
          serviceCompletionForSpec(
            invokeId,
            startBlock,
            spec,
            spec.chain === "bc2" ? hotelProvider : trainProvider,
          ),
        ),
      );
      if (completions.every(Boolean)) {
        const latest = completions
          .filter((value): value is { blockNumber: number; timestamp: number } => value !== null)
          .sort((a, b) => (a.timestamp === b.timestamp ? a.blockNumber - b.blockNumber : a.timestamp - b.timestamp))
          .at(-1);
        if (latest) {
          finalBlock = latest.blockNumber;
          finalTimestamp = latest.timestamp;
          finalObservedAtMs = Date.now();
          finalStatus = Number((await withRetry(`[depth=${depth}][run=${run}] final status`, () => service.getInvocation(invokeId))).status);
          break;
        }
      }
      await sleep(pollIntervalMs);
    }

    if (finalStatus !== 7 && finalStatus !== 8) {
      throw new Error(`Atom 1b invokeId=${invokeId} depth=${depth} did not settle within ${timeoutSeconds}s`);
    }
    if (finalTimestamp === startTimestamp && finalBlock === startBlock) {
      throw new Error(`Atom 1b invokeId=${invokeId} depth=${depth} settled on bc1 but service unlocks were not observed`);
    }

    const latencyMs = finalObservedAtMs - submitAtMs;
    const sample: Sample = {
      run,
      invokeId,
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
      `[Atom-1B][depth=${depth}][run=${run}] invokeId=${invokeId} status=${finalStatus} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`,
    );
  }

  const result = {
    protocol: "atom",
    mode: "rq1b-depth",
    depth,
    summary: summarize(samples),
    samples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `atom-1b-d${depth}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
