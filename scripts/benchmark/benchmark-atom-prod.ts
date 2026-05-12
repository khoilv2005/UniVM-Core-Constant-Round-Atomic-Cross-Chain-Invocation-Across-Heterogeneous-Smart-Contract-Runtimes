/// <reference types="@nomicfoundation/hardhat-ethers" />
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
  remoteUnlockActionsDone: number;
};

type CheckpointAction = {
  tx_id?: string;
  source_event?: string;
  dest_vm?: string;
  dest_chain?: string;
  status?: string;
};

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
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

async function blockTimestamp(blockNumber: number): Promise<number> {
  const block = await ethers.provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
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

function readCheckpointActions(checkpointPath: string): CheckpointAction[] {
  if (!fs.existsSync(checkpointPath)) {
    return [];
  }
  const raw = fs.readFileSync(checkpointPath, "utf-8").trim();
  if (raw === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, CheckpointAction>;
    return Object.values(parsed);
  } catch {
    // The relayer may be rewriting the checkpoint while this benchmark polls it.
    // A torn read means progress is not observable yet; poll again.
    return [];
  }
}

function remoteUnlockDoneCount(checkpointPath: string, invokeId: string): number {
  const normalizedInvokeId = invokeId.toLowerCase();
  const finalEvents = new Set([
    "InvocationFinalized",
    "InvocationInvalidated",
    "ForceSettleUndoRequired",
    "InvocationForceSettled",
  ]);
  const doneChains = new Set<string>();
  for (const action of readCheckpointActions(checkpointPath)) {
    if ((action.tx_id ?? "").toLowerCase() !== normalizedInvokeId) {
      continue;
    }
    if (!finalEvents.has(action.source_event ?? "")) {
      continue;
    }
    if (action.status !== "done") {
      continue;
    }
    if (action.dest_chain === "bc1") {
      continue;
    }
    doneChains.add(`${action.dest_vm}:${action.dest_chain}`);
  }
  return doneChains.size;
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`ATOM RQ1c benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "30"));
  const depth = Number(getArg("depth", "2"));
  const operationCount = depth >= 5 ? 4 : depth;
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const checkpointPath = path.resolve(getArg("checkpoint", path.join(__dirname, "..", "..", "configs", "relayer", "var", "atom-rq1c-ckpt.json")));
  const expectedRemoteUnlocks = Number(getArg("expected-remote-unlocks", String(operationCount)));

  const deploymentBc1 = loadDeployment("bc1");
  const service = await ethers.getContractAt("AtomService", deploymentBc1.contracts.atomService);
  const userPrivateKey = getArg("user-private-key", "");
  const userSigner =
    userPrivateKey.trim() !== ""
      ? new ethers.Wallet(userPrivateKey.trim(), ethers.provider)
      : (await ethers.getSigners())[0];
  const entry =
    depth === 2
      ? (await ethers.getContractAt("AtomTravelEntry", deploymentBc1.contracts.atomTravelEntry)).connect(userSigner)
      : (await ethers.getContractAt("AtomTravelDepthEntry", deploymentBc1.contracts.atomTravelDepthEntry)).connect(userSigner);

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`atom-rq1c-d${depth}-${run}-${Date.now()}`));
    const submitAtMs = Date.now();
    const tx =
      depth === 2
        ? await entry.invokeWriteOnly(invokeId, 1, 1, 1, { gasLimit: 1_200_000 })
        : await entry.invokeWriteOnlyDepth(invokeId, operationCount, 1, 1, 1, { gasLimit: 1_200_000 });
    const receipt = await tx.wait();
    const startBlock = receipt!.blockNumber;
    const startTimestamp = await blockTimestamp(startBlock);

    const startedAt = Date.now();
    let finalStatus = Number((await service.getInvocation(invokeId)).status);
    let remoteDone = 0;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      finalStatus = Number((await service.getInvocation(invokeId)).status);
      remoteDone = remoteUnlockDoneCount(checkpointPath, invokeId);
      if ((finalStatus === 7 || finalStatus === 8) && remoteDone >= expectedRemoteUnlocks) {
        finalObservedAtMs = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (finalStatus !== 7 && finalStatus !== 8) {
      throw new Error(`ATOM RQ1c invokeId=${invokeId} did not settle within ${timeoutSeconds}s`);
    }
    if (remoteDone < expectedRemoteUnlocks) {
      throw new Error(`ATOM RQ1c invokeId=${invokeId} settled on bc1 but only ${remoteDone}/${expectedRemoteUnlocks} remote unlock actions finished`);
    }

    const finalBlock = await ethers.provider.getBlockNumber();
    const finalTimestamp = await blockTimestamp(finalBlock);
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
      remoteUnlockActionsDone: remoteDone,
    };
    samples.push(sample);
    console.log(`[ATOM-RQ1c][run=${run}] invokeId=${invokeId} status=${finalStatus} remoteDone=${remoteDone} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`);
  }

  const result = {
    protocol: "atom",
    mode: "live-e2e-heterogeneous",
    workflow: `rq1c_evm_wasm_fabric_depth${depth}_write_only`,
    depth,
    operationCount,
    expectedRemoteUnlocks,
    checkpointPath,
    summary: summarize(samples),
    samples,
  };
  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const defaultOutput = depth === 2 ? "atom-prod.json" : `atom-prod-d${depth}.json`;
  const outputPath = path.join(outputDir, getArg("output", defaultOutput));
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
