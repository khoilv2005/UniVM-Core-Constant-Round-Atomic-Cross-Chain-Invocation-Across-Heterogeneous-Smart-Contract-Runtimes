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

type ServiceCompletion = {
  blockNumber: number;
  timestamp: number;
  chain: "bc2" | "bc3";
  eventName: string;
};

async function latestMatchingEvent(
  contract: ethers.Contract,
  filters: ethers.DeferredTopicFilter[],
  fromBlock: number,
  toBlock: number,
): Promise<ethers.EventLog | null> {
  let latest: ethers.EventLog | null = null;
  for (const filter of filters) {
    const events = await contract.queryFilter(filter, fromBlock, toBlock);
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

async function findServiceCompletion(
  invokeId: string,
  startBlock: number,
  hotel: ethers.Contract,
  train: ethers.Contract,
): Promise<ServiceCompletion | null> {
  const hotelProvider = hotel.runner?.provider;
  const trainProvider = train.runner?.provider;
  if (!hotelProvider || !trainProvider) {
    throw new Error("Atom benchmark service providers not configured");
  }

  const [hotelLatest, trainLatest] = await Promise.all([
    hotelProvider.getBlockNumber(),
    trainProvider.getBlockNumber(),
  ]);
  const [hotelEvent, trainEvent] = await Promise.all([
    latestMatchingEvent(
      hotel,
      [hotel.filters.AtomHotelUnlocked(invokeId), hotel.filters.AtomHotelUndoUnlocked(invokeId)],
      startBlock,
      hotelLatest,
    ),
    latestMatchingEvent(
      train,
      [train.filters.AtomTrainUnlocked(invokeId), train.filters.AtomTrainUndoUnlocked(invokeId)],
      startBlock,
      trainLatest,
    ),
  ]);

  if (!hotelEvent || !trainEvent) {
    return null;
  }

  const [hotelTimestamp, trainTimestamp] = await Promise.all([
    blockTimestamp(hotelProvider, hotelEvent.blockNumber),
    blockTimestamp(trainProvider, trainEvent.blockNumber),
  ]);

  if (hotelTimestamp > trainTimestamp || (hotelTimestamp === trainTimestamp && hotelEvent.blockNumber >= trainEvent.blockNumber)) {
    return {
      blockNumber: hotelEvent.blockNumber,
      timestamp: hotelTimestamp,
      chain: "bc2",
      eventName: hotelEvent.eventName,
    };
  }

  return {
    blockNumber: trainEvent.blockNumber,
    timestamp: trainTimestamp,
    chain: "bc3",
    eventName: trainEvent.eventName,
  };
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

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`Atom benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "50"));
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const mode = getArg("mode", "write");
  const deploymentBc1 = loadDeployment("bc1");
  const deploymentBc2 = loadDeployment("bc2");
  const deploymentBc3 = loadDeployment("bc3");
  const service = await ethers.getContractAt("AtomService", deploymentBc1.contracts.atomService);
  const entry = await ethers.getContractAt("AtomTravelEntry", deploymentBc1.contracts.atomTravelEntry);

  const hotelProvider = new ethers.JsonRpcProvider(rpcUrlForChain("bc2"));
  const trainProvider = new ethers.JsonRpcProvider(rpcUrlForChain("bc3"));
  const hotel = new ethers.Contract(
    deploymentBc2.contracts.atomHotel,
    [
      "event AtomHotelUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms)",
      "event AtomHotelUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 rooms)",
    ],
    hotelProvider,
  );
  const train = new ethers.Contract(
    deploymentBc3.contracts.atomTrain,
    [
      "event AtomTrainUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets)",
      "event AtomTrainUndoUnlocked(bytes32 indexed invokeId, address indexed user, uint256 outboundTickets, uint256 returnTickets)",
    ],
    trainProvider,
  );

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`atom-benchmark-${mode}-${run}-${Date.now()}`));
    const submitAtMs = Date.now();
    const tx =
      mode === "read"
        ? await entry.invokeReadWrite(invokeId, 1, 1, 1)
        : await entry.invokeWriteOnly(invokeId, 1, 1, 1);
    const receipt = await tx.wait();
    const startBlock = receipt!.blockNumber;
    const startTimestamp = await blockTimestamp(ethers.provider, startBlock);

    const startedAt = Date.now();
    let finalStatus = Number((await service.getInvocation(invokeId)).status);
    let finalBlock = startBlock;
    let finalTimestamp = startTimestamp;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      finalStatus = Number((await service.getInvocation(invokeId)).status);
      if (finalStatus === 7 || finalStatus === 8) {
        const serviceCompletion = await findServiceCompletion(invokeId, startBlock, hotel, train);
        if (serviceCompletion) {
          finalBlock = serviceCompletion.blockNumber;
          finalTimestamp = serviceCompletion.timestamp;
          finalObservedAtMs = Date.now();
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (finalStatus !== 7 && finalStatus !== 8) {
      throw new Error(`Atom invokeId=${invokeId} did not settle within ${timeoutSeconds}s`);
    }
    if (finalTimestamp === startTimestamp && finalBlock === startBlock) {
      throw new Error(`Atom invokeId=${invokeId} settled on bc1 but service unlocks were not observed within ${timeoutSeconds}s`);
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
    };
    samples.push(sample);
    console.log(
      `[Atom][run=${run}] invokeId=${invokeId} status=${finalStatus} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s finalBlock=${finalBlock}`,
    );
  }

  const result = {
    protocol: "atom",
    mode,
    summary: summarize(samples),
    samples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `atom-${mode}-50.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
