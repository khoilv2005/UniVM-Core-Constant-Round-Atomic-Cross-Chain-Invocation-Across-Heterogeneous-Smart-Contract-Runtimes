/// <reference types="@nomicfoundation/hardhat-ethers" />
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Sample = {
  run: number;
  txId: string;
  startBlock: number;
  firstFinalStatusBlock: number;
  finalBlock: number;
  latencySeconds: number;
  latencyMs: number;
  blockLatencySeconds: number;
  finalStatus: number;
  remoteSignalActionsDone: number;
  rootCompletionActionDone: boolean;
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
  const filePath = path.join(__dirname, "..", "..", "deployments", "gpact", `${chain}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    contracts: Record<string, string>;
  };
}

async function blockTimestamp(blockNumber: number): Promise<number> {
  const block = await ethers.provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
}

const controlReadInterface = new ethers.Interface([
  "function txStatus(bytes32) view returns (uint8)",
]);

async function txStatusAtBlock(controlAddress: string, txId: string, blockTag: number): Promise<number> {
  const data = controlReadInterface.encodeFunctionData("txStatus", [txId]);
  const raw = await ethers.provider.call({ to: controlAddress, data, blockTag });
  const [status] = controlReadInterface.decodeFunctionResult("txStatus", raw);
  return Number(status);
}

async function findFirstFinalStatusBlock(controlAddress: string, txId: string, startBlock: number, latestBlock: number): Promise<number> {
  let left = startBlock;
  let right = latestBlock;
  let answer = latestBlock;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const status = await txStatusAtBlock(controlAddress, txId, mid);
    if (status === 5 || status === 6) {
      answer = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return answer;
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
    // The relayer rewrites the checkpoint file while the benchmark polls it.
    // Treat a torn read as "not ready yet" and poll again.
    return [];
  }
}

function gpactCheckpointProgress(
  checkpointPath: string,
  txId: string,
): { remoteSignalActionsDone: number; rootCompletionActionDone: boolean } {
  const normalizedTxId = txId.toLowerCase();
  const remoteSignalChains = new Set<string>();
  let rootCompletionActionDone = false;

  for (const action of readCheckpointActions(checkpointPath)) {
    if ((action.tx_id ?? "").toLowerCase() !== normalizedTxId) {
      continue;
    }
    if (action.status !== "done") {
      continue;
    }

    if (action.source_event === "RootEvent" && action.dest_chain !== "bc1") {
      remoteSignalChains.add(`${action.dest_vm}:${action.dest_chain}`);
    }

    if (action.source_event === "SignallingEvent" && action.dest_chain === "bc1" && action.dest_vm === "evm") {
      rootCompletionActionDone = true;
    }
  }

  return {
    remoteSignalActionsDone: remoteSignalChains.size,
    rootCompletionActionDone,
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

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`GPACT RQ1c benchmark must run with the bc1 config, got network=${network.name}`);
  }

  const runs = Number(getArg("runs", "30"));
  const depth = Number(getArg("depth", "2"));
  const timeoutSeconds = Number(getArg("timeout", "180"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const checkpointPath = path.resolve(getArg("checkpoint", path.join(__dirname, "..", "..", "configs", "relayer", "var", "gpact-rq1c-ckpt.json")));
  const expectedRemoteSignals = Number(getArg("expected-remote-signals", String(depth)));
  const deployment = loadDeployment("bc1");
  const travelRoot = await ethers.getContractAt("GPACTTravelRoot", deployment.contracts.gpactTravelRoot ?? deployment.contracts.travelRoot);
  const control = await ethers.getContractAt("GPACTCrosschainControl", deployment.contracts.gpactCrosschainControl ?? deployment.contracts.crosschainControl);
  const controlAddress = await control.getAddress();

  const samples: Sample[] = [];
  for (let run = 1; run <= runs; run++) {
    const txId = ethers.keccak256(ethers.toUtf8Bytes(`gpact-rq1c-d${depth}-${run}-${Date.now()}`));
    const submitAtMs = Date.now();
    const tx = await travelRoot.startBooking(txId, 1, 1, 1, 99999999);
    const receipt = await tx.wait();
    const startBlock = receipt!.blockNumber;
    const startTimestamp = await blockTimestamp(startBlock);

    const startedAt = Date.now();
    let finalStatus = Number(await control.txStatus(txId));
    let checkpointProgress = gpactCheckpointProgress(checkpointPath, txId);
    let firstFinalStatusBlock = startBlock;
    let finalBlock = startBlock;
    let finalObservedAtMs = submitAtMs;
    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      finalStatus = Number(await control.txStatus(txId));
      checkpointProgress = gpactCheckpointProgress(checkpointPath, txId);
      if (finalStatus === 5 || finalStatus === 6) {
        const latestBlock = await ethers.provider.getBlockNumber();
        if (firstFinalStatusBlock === startBlock) {
          firstFinalStatusBlock = await findFirstFinalStatusBlock(controlAddress, txId, startBlock, latestBlock);
        }
        if (
          checkpointProgress.remoteSignalActionsDone >= expectedRemoteSignals &&
          checkpointProgress.rootCompletionActionDone
        ) {
          finalBlock = latestBlock;
          finalObservedAtMs = Date.now();
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (finalStatus !== 5 && finalStatus !== 6) {
      throw new Error(`GPACT RQ1c txId=${txId} did not finish within ${timeoutSeconds}s`);
    }
    if (checkpointProgress.remoteSignalActionsDone < expectedRemoteSignals || !checkpointProgress.rootCompletionActionDone) {
      throw new Error(
        `GPACT RQ1c txId=${txId} settled on bc1 but checkpoint is incomplete: ` +
          `remoteSignals=${checkpointProgress.remoteSignalActionsDone}/${expectedRemoteSignals}, ` +
          `rootCompletion=${checkpointProgress.rootCompletionActionDone}`,
      );
    }

    const finalTimestamp = await blockTimestamp(finalBlock);
    const latencyMs = finalObservedAtMs - submitAtMs;
    const sample: Sample = {
      run,
      txId,
      startBlock,
      firstFinalStatusBlock,
      finalBlock,
      latencySeconds: latencyMs / 1000,
      latencyMs,
      blockLatencySeconds: finalTimestamp - startTimestamp,
      finalStatus,
      remoteSignalActionsDone: checkpointProgress.remoteSignalActionsDone,
      rootCompletionActionDone: checkpointProgress.rootCompletionActionDone,
    };
    samples.push(sample);
    console.log(
      `[GPACT-RQ1c][run=${run}] txId=${txId} status=${finalStatus} remoteSignals=${sample.remoteSignalActionsDone}/${expectedRemoteSignals} rootCompletion=${sample.rootCompletionActionDone} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s`,
    );
  }

  const result = {
    protocol: "gpact",
    mode: "live-e2e-heterogeneous",
    workflow: `rq1c_evm_wasm_fabric_depth${depth}`,
    depth,
    segmentCount: depth,
    checkpointPath,
    expectedRemoteSignals,
    summary: summarize(samples),
    samples,
  };
  const outputDir = path.join(__dirname, "..", "..", "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const defaultOutput = depth === 2 ? "gpact-prod.json" : `gpact-prod-d${depth}.json`;
  const outputPath = path.join(outputDir, getArg("output", defaultOutput));
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved benchmark results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
