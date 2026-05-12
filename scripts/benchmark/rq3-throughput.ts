/**
 * RQ3a throughput benchmark.
 *
 * Measures completed CCSCI requests per minute under a steady request stream.
 * The default keeps MAX_IN_FLIGHT=1 so RQ3a measures steady-state protocol
 * throughput without turning the experiment into the RQ3c lock-contention
 * scenario. Increase MAX_IN_FLIGHT explicitly when testing pipelined load.
 *
 * Usage:
 *   $env:PROTOCOL="xsmart"; $env:DEPTH="3"
 *   $env:WARMUP_SECONDS="300"; $env:MEASURE_SECONDS="600"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-throughput.ts --network besu
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Protocol = "xsmart" | "integratex" | "gpact" | "atom";

type Deployment = {
  contracts: Record<string, string>;
};

type SubmittedRequest = {
  id: string;
  sequence: number;
  startBlock: number;
  submitStartedAtMs: number;
  submittedAtMs: number;
  submitLatencyMs: number;
  protocolTxHash: string;
};

type TerminalState = {
  terminal: boolean;
  completed: boolean;
  rolledBack: boolean;
  finalStatus: number | string | null;
  finalBlock: number | null;
};

type RequestSample = SubmittedRequest & {
  terminal: boolean;
  completed: boolean;
  rolledBack: boolean;
  timedOut: boolean;
  finalStatus: number | string | null;
  finalBlock: number | null;
  observedAtMs: number | null;
  latencyMs: number | null;
  latencySeconds: number | null;
  phaseAtCompletion: "warmup" | "measurement" | "post_measurement" | "timeout" | null;
};

type ProtocolAdapter = {
  protocol: Protocol;
  mode: string;
  submit: (sequence: number) => Promise<SubmittedRequest>;
  poll: (request: SubmittedRequest) => Promise<TerminalState>;
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

function loadDeployment(system: Protocol, chain: string): Deployment {
  const filePath = path.join(__dirname, "..", "..", "deployments", system, `${chain}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Deployment;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
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
      console.log(`[RQ3a][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function selectedXSmartStateContracts(depth: number, bc2: Deployment, bc3: Deployment): string[] {
  const stateContracts: string[] = [];
  if (depth >= 2) stateContracts.push(bc2.contracts.sHotel);
  if (depth >= 3) stateContracts.push(bc3.contracts.sTrain);
  if (depth >= 4) stateContracts.push(bc2.contracts.sFlight);
  if (depth >= 5) stateContracts.push(bc3.contracts.sTaxi);
  return stateContracts;
}

function selectedIntegrateX(depth: number, bc2: Deployment, bc3: Deployment) {
  const stateContracts: string[] = [];
  const chainIds: number[] = [];
  if (depth >= 2) {
    stateContracts.push(bc2.contracts.sHotel);
    chainIds.push(2);
  }
  if (depth >= 3) {
    stateContracts.push(bc3.contracts.sTrain);
    chainIds.push(3);
  }
  if (depth >= 4) {
    stateContracts.push(bc2.contracts.sFlight);
    chainIds.push(2);
  }
  if (depth >= 5) {
    stateContracts.push(bc3.contracts.sTaxi);
    chainIds.push(3);
  }
  return { stateContracts, chainIds };
}

async function ensureTranslatedBenchmarkState(translatedAddress: string) {
  const translated: any = await ethers.getContractAt("HotelBookingTranslated", translatedAddress);
  const price = await translated.GetPrice();
  if (price !== 0n) return;

  const metaSlot = ethers.solidityPackedKeccak256(["string", "string", "string"], ["VASSP", "HotelBooking", "META"]);
  const metaPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "uint256", "uint256"],
    ["benchmark", 100n, 2000n, 1n],
  );
  await (await translated.__vassp_apply(metaSlot, metaPayload)).wait();
}

async function buildXSmartAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("xsmart", "bc1-1a");
  const bc2 = loadDeployment("xsmart", "bc2-evm");
  const bc3 = loadDeployment("xsmart", "bc3-evm");
  const bridge: any = await ethers.getContractAt("XBridgingContract", bc1.contracts.xBridgingContract);
  await ensureTranslatedBenchmarkState(bc1.contracts.hotelBookingTranslated);
  const stateContracts = selectedXSmartStateContracts(depth, bc2, bc3);
  if (stateContracts.some((value) => !value)) {
    throw new Error(`XSmart RQ3a depth=${depth} missing state contract deployment`);
  }

  return {
    protocol: "xsmart",
    mode: "homogeneous-evm-throughput",
    submit: async (sequence: number) => {
      const txId = BigInt(Date.now()) * 1000n + BigInt(depth * 100 + sequence);
      const submitStartedAtMs = Date.now();
      const fee = await withRetry(`[xsmart][${sequence}] crossChainFee`, () => bridge.crossChainFee());
      const tx: any = await withRetry(`[xsmart][${sequence}] requestLockStates`, () =>
        bridge.requestLockStates(txId, "travel", stateContracts, 30n, 2n, { value: fee }),
      );
      const receipt: any = await withRetry(`[xsmart][${sequence}] wait requestLockStates`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: txId.toString(),
        sequence,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs,
        submitLatencyMs: submittedAtMs - submitStartedAtMs,
        protocolTxHash: receipt!.hash,
      };
    },
    poll: async (request: SubmittedRequest) => {
      const txId = BigInt(request.id);
      const latestBlock = await ethers.provider.getBlockNumber();
      const events = await bridge.queryFilter(bridge.filters.ExecutionCompleted(txId), request.startBlock, latestBlock);
      if (events.length === 0) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: null, finalBlock: null };
      }
      return {
        terminal: true,
        completed: true,
        rolledBack: false,
        finalStatus: "ExecutionCompleted",
        finalBlock: events[events.length - 1].blockNumber,
      };
    },
  };
}

async function buildIntegrateXAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("integratex", "bc1");
  const bc2 = loadDeployment("integratex", "bc2");
  const bc3 = loadDeployment("integratex", "bc3");
  const travelDApp: any = await ethers.getContractAt("CrossChainTravelDepthDApp", bc1.contracts.travelDepthDApp);
  const { stateContracts, chainIds } = selectedIntegrateX(depth, bc2, bc3);

  return {
    protocol: "integratex",
    mode: "homogeneous-evm-throughput",
    submit: async (sequence: number) => {
      const initiateTx: any = await withRetry(`[integratex][${sequence}] initiateExecution`, () =>
        travelDApp.initiateExecution(1, 1, 1),
      );
      const initiateReceipt: any = await withRetry(`[integratex][${sequence}] wait initiateExecution`, () =>
        initiateTx.wait(),
      );
      const initiateEvent = initiateReceipt!.logs
        .map((log: any) => {
          try {
            return travelDApp.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((entry: any) => entry?.name === "CrossChainExecutionInitiated");
      if (!initiateEvent) throw new Error("CrossChainExecutionInitiated event not found");

      const txId = Number(initiateEvent.args.crossChainTxId);
      const submitStartedAtMs = Date.now();
      const lockTx: any = await withRetry(`[integratex][${sequence}] startLocking`, () =>
        travelDApp.startLocking(txId, stateContracts, chainIds),
      );
      const lockReceipt: any = await withRetry(`[integratex][${sequence}] wait startLocking`, () => lockTx.wait());
      const submittedAtMs = Date.now();
      return {
        id: String(txId),
        sequence,
        startBlock: lockReceipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs,
        submitLatencyMs: submittedAtMs - submitStartedAtMs,
        protocolTxHash: lockReceipt!.hash,
      };
    },
    poll: async (request: SubmittedRequest) => {
      const status = Number(await travelDApp.getExecutionStatus(Number(request.id)));
      if (status !== 7 && status !== 8) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      const latestBlock = await ethers.provider.getBlockNumber();
      return {
        terminal: true,
        completed: status === 7,
        rolledBack: status === 8,
        finalStatus: status,
        finalBlock: latestBlock,
      };
    },
  };
}

async function buildGPACTAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("gpact", "bc1");
  const travelRoot: any = await ethers.getContractAt(
    "GPACTTravelRoot",
    bc1.contracts.gpactTravelRoot ?? bc1.contracts.travelRoot,
  );
  const control: any = await ethers.getContractAt(
    "GPACTCrosschainControl",
    bc1.contracts.gpactCrosschainControl ?? bc1.contracts.crosschainControl,
  );

  return {
    protocol: "gpact",
    mode: "homogeneous-evm-throughput",
    submit: async (sequence: number) => {
      const txId = ethers.keccak256(ethers.toUtf8Bytes(`rq3a-gpact-depth-${depth}-${sequence}-${Date.now()}`));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[gpact][${sequence}] startBooking`, () =>
        travelRoot.startBooking(txId, 1, 1, 1, 99999999),
      );
      const receipt: any = await withRetry(`[gpact][${sequence}] wait startBooking`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: txId,
        sequence,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs,
        submitLatencyMs: submittedAtMs - submitStartedAtMs,
        protocolTxHash: receipt!.hash,
      };
    },
    poll: async (request: SubmittedRequest) => {
      const status = Number(await control.txStatus(request.id));
      if (status !== 5 && status !== 6) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      const latestBlock = await ethers.provider.getBlockNumber();
      return {
        terminal: true,
        completed: status === 5,
        rolledBack: status === 6,
        finalStatus: status,
        finalBlock: latestBlock,
      };
    },
  };
}

async function buildATOMAdapter(depth: number, invokeGasLimit: bigint): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("atom", "bc1");
  const [deployer] = await ethers.getSigners();
  const service: any = await ethers.getContractAt(
    [
      "function getInvocation(bytes32 invokeId) view returns ((bytes32 invokeId, bytes32 workflowId, address entry, address server, uint256 startedBlock, uint256 serviceDeadlineBlock, uint256 auditDeadlineBlock, uint256 totalOperationCount, uint256 proofCount, uint256 judgeNumNeed, uint256 judgeNumMin, uint256 validVoteCount, uint256 invalidVoteCount, bool proofSubmissionComplete, uint8 status, address[] judges))",
    ],
    bc1.contracts.atomService,
    deployer,
  );
  const entry: any = await ethers.getContractAt(
    [
      "function invokeWriteOnlyDepth(bytes32 invokeId, uint256 totalOperationCount, uint256 numRooms, uint256 numOutboundTickets, uint256 numReturnTickets)",
    ],
    bc1.contracts.atomTravelDepthEntry,
    deployer,
  );

  return {
    protocol: "atom",
    mode: "homogeneous-evm-throughput",
    submit: async (sequence: number) => {
      const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`rq3a-atom-depth-${depth}-${sequence}-${Date.now()}`));
      const totalOperationCount = BigInt(Math.max(1, depth - 1));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[atom][${sequence}] invokeWriteOnlyDepth`, () =>
        entry.invokeWriteOnlyDepth(invokeId, totalOperationCount, 1, 1, 1, { gasLimit: invokeGasLimit }),
      );
      const receipt: any = await withRetry(`[atom][${sequence}] wait invokeWriteOnlyDepth`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: invokeId,
        sequence,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs,
        submitLatencyMs: submittedAtMs - submitStartedAtMs,
        protocolTxHash: receipt!.hash,
      };
    },
    poll: async (request: SubmittedRequest) => {
      const invocation = await service.getInvocation(request.id);
      const status = Number(invocation.status);
      if (status !== 7 && status !== 8) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      const latestBlock = await ethers.provider.getBlockNumber();
      return {
        terminal: true,
        completed: status === 7,
        rolledBack: status === 8,
        finalStatus: status,
        finalBlock: latestBlock,
      };
    },
  };
}

async function buildAdapter(protocol: Protocol, depth: number, invokeGasLimit: bigint): Promise<ProtocolAdapter> {
  if (protocol === "xsmart") return buildXSmartAdapter(depth);
  if (protocol === "integratex") return buildIntegrateXAdapter(depth);
  if (protocol === "gpact") return buildGPACTAdapter(depth);
  return buildATOMAdapter(depth, invokeGasLimit);
}

function phaseForTimestamp(
  observedAtMs: number,
  warmupStartMs: number,
  measurementStartMs: number,
  measurementEndMs: number,
): "warmup" | "measurement" | "post_measurement" {
  if (observedAtMs < measurementStartMs) return "warmup";
  if (observedAtMs <= measurementEndMs) return "measurement";
  if (observedAtMs >= warmupStartMs) return "post_measurement";
  return "warmup";
}

function latencySummary(samples: RequestSample[]) {
  const completed = samples
    .filter((sample) => sample.completed && sample.latencyMs !== null)
    .map((sample) => sample.latencyMs as number)
    .sort((a, b) => a - b);
  const sum = completed.reduce((total, value) => total + value, 0);
  const avg = completed.length === 0 ? 0 : sum / completed.length;
  const median =
    completed.length === 0
      ? 0
      : completed.length % 2 === 1
        ? completed[(completed.length - 1) / 2]
        : (completed[completed.length / 2 - 1] + completed[completed.length / 2]) / 2;
  const variance =
    completed.length === 0
      ? 0
      : completed.reduce((total, value) => total + (value - avg) ** 2, 0) / completed.length;
  return {
    avgCompletionLatencyMs: avg,
    medianCompletionLatencyMs: median,
    stdCompletionLatencyMs: Math.sqrt(variance),
    avgCompletionLatencySeconds: avg / 1000,
    medianCompletionLatencySeconds: median / 1000,
    stdCompletionLatencySeconds: Math.sqrt(variance) / 1000,
  };
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`RQ3a benchmark must run with a bc1/besu config, got network=${network.name}`);
  }

  const protocol = getArg("protocol", "xsmart").toLowerCase() as Protocol;
  if (!["xsmart", "integratex", "gpact", "atom"].includes(protocol)) {
    throw new Error(`Unsupported PROTOCOL=${protocol}`);
  }

  const depth = Number(getArg("depth", "2"));
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`DEPTH must be one of 2,3,4,5; got ${depth}`);
  }

  const warmupSeconds = Number(getArg("warmup-seconds", "300"));
  const measureSeconds = Number(getArg("measure-seconds", "600"));
  const drainTimeoutSeconds = Number(getArg("drain-timeout-seconds", "360"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const maxInFlight = Number(getArg("max-in-flight", "1"));
  const submitGapMs = Number(getArg("submit-gap-ms", "0"));
  const invokeGasLimit = BigInt(getArg("invoke-gas-limit", "800000"));
  const outputOverride = getArg("out", "");
  const dryRun = getArg("dry-run", "0") === "1";

  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`MAX_IN_FLIGHT must be a positive integer, got ${maxInFlight}`);
  }
  if (warmupSeconds < 0 || measureSeconds <= 0 || drainTimeoutSeconds < 0) {
    throw new Error("WARMUP_SECONDS must be >=0, MEASURE_SECONDS >0, DRAIN_TIMEOUT_SECONDS >=0");
  }
  if (dryRun) {
    console.log(
      `[RQ3a][dry-run] protocol=${protocol} depth=${depth} warmup=${warmupSeconds}s measure=${measureSeconds}s maxInFlight=${maxInFlight}`,
    );
    return;
  }

  const adapter = await buildAdapter(protocol, depth, invokeGasLimit);
  const samples = new Map<string, RequestSample>();
  const inFlight = new Map<string, SubmittedRequest>();
  let nextSequence = 1;

  const benchmarkStartMs = Date.now();
  const measurementStartMs = benchmarkStartMs + warmupSeconds * 1000;
  const measurementEndMs = measurementStartMs + measureSeconds * 1000;
  const drainEndMs = measurementEndMs + drainTimeoutSeconds * 1000;

  async function submitOne() {
    const request = await adapter.submit(nextSequence++);
    samples.set(request.id, {
      ...request,
      terminal: false,
      completed: false,
      rolledBack: false,
      timedOut: false,
      finalStatus: null,
      finalBlock: null,
      observedAtMs: null,
      latencyMs: null,
      latencySeconds: null,
      phaseAtCompletion: null,
    });
    inFlight.set(request.id, request);
    console.log(
      `[RQ3a][${protocol}][d=${depth}] submitted seq=${request.sequence} id=${request.id} inFlight=${inFlight.size}`,
    );
    if (submitGapMs > 0) await sleep(submitGapMs);
  }

  async function fillPipeline(nowMs: number) {
    while (nowMs < measurementEndMs && inFlight.size < maxInFlight) {
      await submitOne();
      nowMs = Date.now();
    }
  }

  console.log(
    `[RQ3a][${protocol}] start depth=${depth} warmup=${warmupSeconds}s measure=${measureSeconds}s maxInFlight=${maxInFlight} mode=${adapter.mode}`,
  );
  await fillPipeline(Date.now());

  while (Date.now() < measurementEndMs || inFlight.size > 0) {
    const nowMs = Date.now();
    if (nowMs > drainEndMs) {
      break;
    }

    const requests = Array.from(inFlight.values());
    for (const request of requests) {
      const status = await withRetry(`[${protocol}][${request.sequence}] poll`, () => adapter.poll(request));
      if (!status.terminal) continue;

      const observedAtMs = Date.now();
      const latencyMs = observedAtMs - request.submitStartedAtMs;
      const phaseAtCompletion = phaseForTimestamp(observedAtMs, benchmarkStartMs, measurementStartMs, measurementEndMs);
      const current = samples.get(request.id);
      if (!current) throw new Error(`Internal error: missing sample for id=${request.id}`);
      samples.set(request.id, {
        ...current,
        terminal: true,
        completed: status.completed,
        rolledBack: status.rolledBack,
        timedOut: false,
        finalStatus: status.finalStatus,
        finalBlock: status.finalBlock,
        observedAtMs,
        latencyMs,
        latencySeconds: latencyMs / 1000,
        phaseAtCompletion,
      });
      inFlight.delete(request.id);
      console.log(
        `[RQ3a][${protocol}][d=${depth}] terminal seq=${request.sequence} status=${status.finalStatus} completed=${status.completed} phase=${phaseAtCompletion} latency=${(latencyMs / 1000).toFixed(3)}s`,
      );
    }

    await fillPipeline(Date.now());
    if (Date.now() >= measurementEndMs && inFlight.size === 0) break;
    await sleep(pollIntervalMs);
  }

  const benchmarkEndMs = Date.now();
  for (const request of inFlight.values()) {
    const current = samples.get(request.id);
    if (!current) continue;
    samples.set(request.id, {
      ...current,
      terminal: false,
      completed: false,
      rolledBack: false,
      timedOut: true,
      observedAtMs: benchmarkEndMs,
      latencyMs: benchmarkEndMs - request.submitStartedAtMs,
      latencySeconds: (benchmarkEndMs - request.submitStartedAtMs) / 1000,
      phaseAtCompletion: "timeout",
    });
  }

  const finalSamples = Array.from(samples.values()).sort((a, b) => a.sequence - b.sequence);
  const measurementCompletions = finalSamples.filter(
    (sample) => sample.completed && sample.phaseAtCompletion === "measurement",
  );
  const warmupCompletions = finalSamples.filter((sample) => sample.completed && sample.phaseAtCompletion === "warmup");
  const postMeasurementCompletions = finalSamples.filter(
    (sample) => sample.completed && sample.phaseAtCompletion === "post_measurement",
  );
  const rolledBack = finalSamples.filter((sample) => sample.rolledBack);
  const timedOut = finalSamples.filter((sample) => sample.timedOut);
  const throughputPerMinute = measurementCompletions.length / (measureSeconds / 60);

  const result = {
    schemaVersion: 1,
    rq: "RQ3a",
    protocol,
    mode: adapter.mode,
    workload: {
      depth,
      maxInFlight,
      submissionPolicy:
        "steady stream: keep up to MAX_IN_FLIGHT active requests; default MAX_IN_FLIGHT=1 avoids RQ3c lock contention",
      warmupSeconds,
      measureSeconds,
      drainTimeoutSeconds,
      pollIntervalMs,
      submitGapMs,
    },
    timing: {
      startedAt: new Date(benchmarkStartMs).toISOString(),
      measurementStartedAt: new Date(measurementStartMs).toISOString(),
      measurementEndedAt: new Date(measurementEndMs).toISOString(),
      endedAt: new Date(benchmarkEndMs).toISOString(),
      elapsedSeconds: (benchmarkEndMs - benchmarkStartMs) / 1000,
    },
    summary: {
      submitted: finalSamples.length,
      completed: finalSamples.filter((sample) => sample.completed).length,
      rolledBack: rolledBack.length,
      timedOut: timedOut.length,
      warmupCompletions: warmupCompletions.length,
      measurementCompletions: measurementCompletions.length,
      postMeasurementCompletions: postMeasurementCompletions.length,
      measurementMinutes: measureSeconds / 60,
      throughputCompletedPerMinute: throughputPerMinute,
      ...latencySummary(finalSamples),
    },
    samples: finalSamples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results", "rq3");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath =
    outputOverride.trim() !== ""
      ? path.resolve(outputOverride)
      : path.join(outputDir, `throughput-${protocol}-d${depth}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved RQ3a throughput results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
