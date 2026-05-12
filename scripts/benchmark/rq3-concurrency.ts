/**
 * RQ3c concurrency benchmark.
 *
 * This harness submits a burst of overlapping CCSCI requests for one protocol,
 * then polls all requests until they reach a terminal state. Submissions are
 * sent back-to-back from one signer instead of Promise.all to avoid nonce races
 * on the Besu testbed; protocol execution and lock contention still overlap
 * because the harness does not wait for a request to complete before submitting
 * the next request.
 *
 * Usage examples:
 *   $env:PROTOCOL="xsmart"; $env:CONCURRENCY="4"; $env:DEPTH="3"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-concurrency.ts --network besu
 *
 *   $env:PROTOCOL="integratex"; $env:CONCURRENCY="4"; $env:DEPTH="3"
 *   npx hardhat run --config hardhat.integratex-bc1.config.ts scripts/benchmark/rq3-concurrency.ts --network besu
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
  index: number;
  startBlock: number;
  submitStartedAtMs: number;
  submittedAtMs: number;
  submitLatencyMs: number;
  protocolTxHash: string;
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
  error?: string;
};

type ProtocolAdapter = {
  protocol: Protocol;
  mode: string;
  submit: (index: number) => Promise<SubmittedRequest>;
  poll: (request: SubmittedRequest) => Promise<{
    terminal: boolean;
    completed: boolean;
    rolledBack: boolean;
    finalStatus: number | string | null;
    finalBlock: number | null;
  }>;
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

function trace(message: string) {
  if (process.env.TRACE_RQ3C === "1") {
    const line = `[RQ3c][trace][${new Date().toISOString()}] ${message}`;
    console.log(line);
    const traceFile = process.env.TRACE_RQ3C_FILE;
    if (traceFile && traceFile.trim() !== "") {
      fs.appendFileSync(traceFile, `${line}\n`);
    }
  }
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
    message.includes("timed out") ||
    message.includes("transaction dropped") ||
    message.includes("econnreset") ||
    message.includes("temporarily unavailable")
  );
}

async function withRetry<T>(label: string, action: () => Promise<T>, attempts = 5, delayMs = 3000): Promise<T> {
  let lastError: unknown;
  const actionTimeoutMs = Number(process.env.RPC_ACTION_TIMEOUT_MS ?? "120000");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${actionTimeoutMs}ms`)),
          actionTimeoutMs,
        );
      });
      try {
        return await Promise.race([action(), timeoutPromise]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[RQ3c][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function sendAndWait(
  label: string,
  send: () => Promise<any>,
  attempts = 5,
  delayMs = 3000,
): Promise<{ tx: any; receipt: any }> {
  let lastError: unknown;
  const actionTimeoutMs = Number(process.env.RPC_ACTION_TIMEOUT_MS ?? "120000");
  const droppedGraceMs = Number(process.env.RPC_DROPPED_GRACE_MS ?? "15000");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let tx: any;
    try {
      tx = await withRetry(`${label} send`, send, 1, delayMs);
      trace(`${label} sent hash=${tx.hash}`);
      const receipt = await withRetry(
        `${label} wait receipt`,
        async () => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < actionTimeoutMs) {
            const rawReceipt = await ethers.provider.send("eth_getTransactionReceipt", [tx.hash]);
            if (rawReceipt !== null) {
              return {
                ...rawReceipt,
                blockNumber: Number(rawReceipt.blockNumber),
                hash: rawReceipt.transactionHash,
              };
            }
            const rawTx = await ethers.provider.send("eth_getTransactionByHash", [tx.hash]);
            if (rawTx === null && Date.now() - startedAt >= droppedGraceMs) {
              throw new Error(`${label} transaction dropped before mining hash=${tx.hash}`);
            }
            await sleep(1000);
          }
          throw new Error(`${label} receipt timed out after ${actionTimeoutMs}ms hash=${tx.hash}`);
        },
        1,
        delayMs,
      );
      return { tx, receipt };
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const hash = tx?.hash ? ` hash=${tx.hash}` : "";
      console.log(`[RQ3c][retry] ${label} attempt=${attempt}/${attempts} failed:${hash} ${message}`);
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

async function getBenchmarkSigner(index = 0) {
  const defaultBenchmarkPrivateKey =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  let privateKey = process.env.BENCHMARK_PRIVATE_KEY ?? defaultBenchmarkPrivateKey;
  if (process.env.MULTI_ACCOUNT === "1" && !process.env.BENCHMARK_PRIVATE_KEY) {
    privateKey = `0x${(0x100000n + BigInt(index)).toString(16).padStart(64, "0")}`;
  }
  const wallet = new ethers.Wallet(privateKey, ethers.provider);
  const minBalance = ethers.parseEther(process.env.BENCHMARK_MIN_BALANCE_ETH ?? "1");
  const topUpAmount = ethers.parseEther(process.env.BENCHMARK_TOP_UP_ETH ?? "5");
  const balance = await ethers.provider.getBalance(wallet.address);
  if (balance < minBalance && process.env.BENCHMARK_AUTO_FUND !== "0") {
    const [deployer] = await ethers.getSigners();
    console.log(
      `[RQ3c][fund] funding benchmark signer ${wallet.address} balance=${ethers.formatEther(balance)} ETH`,
    );
    const tx = await deployer.sendTransaction({ to: wallet.address, value: topUpAmount });
    await tx.wait();
  }
  return wallet;
}

async function buildXSmartAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("xsmart", "bc1-1a");
  const bc2 = loadDeployment("xsmart", "bc2-evm");
  const bc3 = loadDeployment("xsmart", "bc3-evm");
  const bridge: any = await ethers.getContractAt("XBridgingContract", bc1.contracts.xBridgingContract);
  const timeoutTriggered = new Set<string>();
  await ensureTranslatedBenchmarkState(bc1.contracts.hotelBookingTranslated);
  const stateContracts = selectedXSmartStateContracts(depth, bc2, bc3);
  if (stateContracts.some((value) => !value)) {
    throw new Error(`XSmart RQ3c depth=${depth} missing state contract deployment`);
  }

  return {
    protocol: "xsmart",
    mode: "homogeneous-evm-concurrency",
    submit: async (index: number) => {
      const signer = await getBenchmarkSigner(index);
      const connectedBridge = bridge.connect(signer);
      const txId = BigInt(Date.now()) * 1000n + BigInt(index);
      const submitStartedAtMs = Date.now();
      const fee = await withRetry(`[xsmart][${index}] crossChainFee`, () => bridge.crossChainFee());
      const tx: any = await withRetry(`[xsmart][${index}] requestLockStates`, () =>
        connectedBridge.requestLockStates(txId, "travel", stateContracts, 30n, 2n, { value: fee }),
      );
      const receipt: any = await withRetry(`[xsmart][${index}] wait requestLockStates`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: txId.toString(),
        index,
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
      if (events.length > 0) {
        return {
          terminal: true,
          completed: true,
          rolledBack: false,
          finalStatus: "ExecutionCompleted",
          finalBlock: events[events.length - 1].blockNumber,
        };
      }

      const execution = await bridge.activeExecutions(txId);
      const active = Boolean(execution.active ?? execution[5]);
      const phase = Number(execution.phase ?? execution[6]);
      const startBlock = Number(execution.startBlock ?? execution[2]);
      const timeoutBlocks = Number(execution.timeoutBlocks ?? execution[3]);
      if (phase === 4) {
        return { terminal: true, completed: true, rolledBack: false, finalStatus: "Completed", finalBlock: latestBlock };
      }
      if (phase === 3 || phase === 5) {
        return { terminal: true, completed: false, rolledBack: true, finalStatus: phase === 3 ? "AbortDecided" : "RolledBack", finalBlock: latestBlock };
      }
      if (
        active &&
        phase === 1 &&
        process.env.XSMART_AUTO_TIMEOUT === "1" &&
        latestBlock > startBlock + timeoutBlocks &&
        !timeoutTriggered.has(request.id)
      ) {
        timeoutTriggered.add(request.id);
        const tx = await bridge.timeoutExecution(txId, { gasLimit: 500000 });
        const receipt = await tx.wait();
        return { terminal: true, completed: false, rolledBack: true, finalStatus: "TimeoutRollback", finalBlock: receipt.blockNumber };
      }
      return { terminal: false, completed: false, rolledBack: false, finalStatus: phase, finalBlock: null };
    },
  };
}

async function buildIntegrateXAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("integratex", "bc1");
  const bc2 = loadDeployment("integratex", "bc2");
  const bc3 = loadDeployment("integratex", "bc3");
  const benchmarkSigner = await getBenchmarkSigner();
  const travelDApp: any = (await ethers.getContractAt(
    "CrossChainTravelDepthDApp",
    bc1.contracts.travelDepthDApp,
  )).connect(benchmarkSigner);
  const { stateContracts, chainIds } = selectedIntegrateX(depth, bc2, bc3);

  return {
    protocol: "integratex",
    mode: "homogeneous-evm-concurrency",
    submit: async (index: number) => {
      const perRequestSigner = process.env.MULTI_ACCOUNT === "1" ? await getBenchmarkSigner(index) : benchmarkSigner;
      const perRequestTravelDApp = travelDApp.connect(perRequestSigner);
      trace(`[integratex][${index}] before initiateExecution`);
      const { tx: initiateTx, receipt: initiateReceipt } = await sendAndWait(`[integratex][${index}] initiateExecution`, () =>
        perRequestTravelDApp.initiateExecution(1, 1, 1),
      );
      trace(
        `[integratex][${index}] initiateExecution mined block=${initiateReceipt!.blockNumber} hash=${initiateReceipt!.hash}`,
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
      if (!initiateEvent) {
        throw new Error("CrossChainExecutionInitiated event not found");
      }
      const txId = Number(initiateEvent.args.crossChainTxId);
      trace(`[integratex][${index}] parsed txId=${txId}`);
      const submitStartedAtMs = Date.now();
      trace(`[integratex][${index}] before startLocking txId=${txId}`);
      const { tx: lockTx, receipt: lockReceipt } = await sendAndWait(`[integratex][${index}] startLocking`, () =>
        perRequestTravelDApp.startLocking(txId, stateContracts, chainIds),
      );
      trace(
        `[integratex][${index}] startLocking mined block=${lockReceipt!.blockNumber} hash=${lockReceipt!.hash}`,
      );
      const submittedAtMs = Date.now();
      return {
        id: String(txId),
        index,
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

async function buildGPACTAdapter(): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("gpact", "bc1");
  const benchmarkSigner = await getBenchmarkSigner();
  const baseTravelRoot: any = (await ethers.getContractAt(
    "GPACTTravelRoot",
    bc1.contracts.gpactTravelRoot ?? bc1.contracts.travelRoot,
  )).connect(benchmarkSigner);
  const control: any = await ethers.getContractAt(
    "GPACTCrosschainControl",
    bc1.contracts.gpactCrosschainControl ?? bc1.contracts.crosschainControl,
  );

  return {
    protocol: "gpact",
    mode: "homogeneous-evm-concurrency",
    submit: async (index: number) => {
      const signer = process.env.MULTI_ACCOUNT === "1" ? await getBenchmarkSigner(index) : benchmarkSigner;
      const travelRoot = baseTravelRoot.connect(signer);
      const txId = ethers.keccak256(ethers.toUtf8Bytes(`rq3c-gpact-${index}-${Date.now()}`));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[gpact][${index}] startBooking`, () =>
        travelRoot.startBooking(txId, 1, 1, 1, 99999999),
      );
      const receipt: any = await withRetry(`[gpact][${index}] wait startBooking`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: txId,
        index,
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
  const benchmarkSigner = await getBenchmarkSigner();
  const [deployer] = await ethers.getSigners();
  const service: any = await ethers.getContractAt(
    [
      "function getInvocation(bytes32 invokeId) view returns ((bytes32 invokeId, bytes32 workflowId, address entry, address server, uint256 startedBlock, uint256 serviceDeadlineBlock, uint256 auditDeadlineBlock, uint256 totalOperationCount, uint256 proofCount, uint256 judgeNumNeed, uint256 judgeNumMin, uint256 validVoteCount, uint256 invalidVoteCount, bool proofSubmissionComplete, uint8 status, address[] judges))",
    ],
    bc1.contracts.atomService,
    deployer,
  );
  const baseEntry: any = await ethers.getContractAt(
    [
      "function invokeWriteOnlyDepth(bytes32 invokeId, uint256 totalOperationCount, uint256 numRooms, uint256 numOutboundTickets, uint256 numReturnTickets)",
    ],
    bc1.contracts.atomTravelDepthEntry,
    benchmarkSigner,
  );

  return {
    protocol: "atom",
    mode: "homogeneous-evm-concurrency",
    submit: async (index: number) => {
      const signer = process.env.MULTI_ACCOUNT === "1" ? await getBenchmarkSigner(index) : benchmarkSigner;
      const entry = baseEntry.connect(signer);
      const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`rq3c-atom-depth-${depth}-${index}-${Date.now()}`));
      const totalOperationCount = BigInt(Math.max(1, depth - 1));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[atom][${index}] invokeWriteOnlyDepth`, () =>
        entry.invokeWriteOnlyDepth(invokeId, totalOperationCount, 1, 1, 1, { gasLimit: invokeGasLimit }),
      );
      const receipt: any = await withRetry(`[atom][${index}] wait invokeWriteOnlyDepth`, () => tx.wait());
      const submittedAtMs = Date.now();
      return {
        id: invokeId,
        index,
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

function summarize(samples: RequestSample[]) {
  const terminal = samples.filter((sample) => sample.terminal);
  const completed = samples.filter((sample) => sample.completed);
  const rolledBack = samples.filter((sample) => sample.rolledBack);
  const timedOut = samples.filter((sample) => sample.timedOut);
  const latenciesMs = completed
    .map((sample) => sample.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const sum = latenciesMs.reduce((total, value) => total + value, 0);
  const avg = latenciesMs.length > 0 ? sum / latenciesMs.length : 0;
  const median =
    latenciesMs.length === 0
      ? 0
      : latenciesMs.length % 2 === 1
        ? latenciesMs[(latenciesMs.length - 1) / 2]
        : (latenciesMs[latenciesMs.length / 2 - 1] + latenciesMs[latenciesMs.length / 2]) / 2;
  const percentile = (p: number) => {
    if (latenciesMs.length === 0) {
      return 0;
    }
    const rank = Math.ceil((p / 100) * latenciesMs.length) - 1;
    const index = Math.min(Math.max(rank, 0), latenciesMs.length - 1);
    return latenciesMs[index];
  };
  const p90 = percentile(90);
  const p95 = percentile(95);
  const p99 = percentile(99);
  const recoveryLatenciesMs = rolledBack
    .map((sample) => sample.latencyMs)
    .filter((value): value is number => value !== null);
  const avgRecoveryMs = recoveryLatenciesMs.length === 0
    ? 0
    : recoveryLatenciesMs.reduce((total, value) => total + value, 0) / recoveryLatenciesMs.length;
  const aborted = rolledBack.length + timedOut.length;
  const variance =
    latenciesMs.length === 0
      ? 0
      : latenciesMs.reduce((total, value) => total + (value - avg) ** 2, 0) / latenciesMs.length;
  const stdMs = Math.sqrt(variance);

  return {
    submitted: samples.length,
    terminal: terminal.length,
    completed: completed.length,
    rolledBack: rolledBack.length,
    timedOut: timedOut.length,
    successRate: samples.length === 0 ? 0 : completed.length / samples.length,
    completionRate: samples.length === 0 ? 0 : completed.length / samples.length,
    abortRate: samples.length === 0 ? 0 : aborted / samples.length,
    lockConflictRate: samples.length === 0 ? 0 : aborted / samples.length,
    avgCompletionLatencyMs: avg,
    medianCompletionLatencyMs: median,
    p50CompletionLatencyMs: median,
    p90CompletionLatencyMs: p90,
    p95CompletionLatencyMs: p95,
    p99CompletionLatencyMs: p99,
    stdCompletionLatencyMs: stdMs,
    avgCompletionLatencySeconds: avg / 1000,
    medianCompletionLatencySeconds: median / 1000,
    p50CompletionLatencySeconds: median / 1000,
    p90CompletionLatencySeconds: p90 / 1000,
    p95CompletionLatencySeconds: p95 / 1000,
    p99CompletionLatencySeconds: p99 / 1000,
    stdCompletionLatencySeconds: stdMs / 1000,
    avgRecoveryTimeMs: avgRecoveryMs,
    avgRecoveryTimeSeconds: avgRecoveryMs / 1000,
  };
}

async function buildAdapter(protocol: Protocol, depth: number, invokeGasLimit: bigint): Promise<ProtocolAdapter> {
  if (protocol === "xsmart") return buildXSmartAdapter(depth);
  if (protocol === "integratex") return buildIntegrateXAdapter(depth);
  if (protocol === "gpact") return buildGPACTAdapter();
  return buildATOMAdapter(depth, invokeGasLimit);
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`RQ3c benchmark must run with a bc1/besu config, got network=${network.name}`);
  }

  const protocol = getArg("protocol", "xsmart").toLowerCase() as Protocol;
  if (!["xsmart", "integratex", "gpact", "atom"].includes(protocol)) {
    throw new Error(`Unsupported PROTOCOL=${protocol}`);
  }
  const concurrency = Number(getArg("concurrency", "1"));
  const depth = Number(getArg("depth", "3"));
  const timeoutSeconds = Number(getArg("timeout", "360"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const submitGapMs = Number(getArg("submit-gap-ms", "0"));
  const invokeGasLimit = BigInt(getArg("invoke-gas-limit", "800000"));
  const outputOverride = getArg("out", "");
  const contention = getArg("contention", process.env.CONTENTION ?? "unspecified");
  const hotLockFraction = Number(getArg("hot-lock-fraction", process.env.HOT_LOCK_FRACTION ?? "0"));
  const dryRun = getArg("dry-run", "0") === "1";
  const fundBenchmarkOnly = getArg("fund-benchmark-only", "0") === "1";
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`CONCURRENCY must be a positive integer, got ${concurrency}`);
  }
  if (![2, 3, 4, 5].includes(depth)) {
    throw new Error(`DEPTH must be one of 2,3,4,5; got ${depth}`);
  }
  if (dryRun) {
    console.log(`[RQ3c][dry-run] protocol=${protocol} concurrency=${concurrency} depth=${depth}`);
    return;
  }
  if (fundBenchmarkOnly) {
    const wallet = await getBenchmarkSigner();
    const balance = await ethers.provider.getBalance(wallet.address);
    console.log(`[RQ3c][fund] benchmark signer ${wallet.address} balance=${ethers.formatEther(balance)} ETH`);
    return;
  }

  const adapter = await buildAdapter(protocol, depth, invokeGasLimit);
  const submitted: SubmittedRequest[] = [];
  const samples = new Map<string, RequestSample>();
  const benchmarkStartedAtMs = Date.now();

  console.log(
    `[RQ3c][${protocol}] start concurrency=${concurrency} depth=${depth} timeout=${timeoutSeconds}s mode=${adapter.mode}`,
  );
  const registerSubmission = (request: SubmittedRequest) => {
    submitted.push(request);
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
    });
    console.log(
      `[RQ3c][${protocol}] submitted ${request.index}/${concurrency} id=${request.id} block=${request.startBlock} submitLatency=${(request.submitLatencyMs / 1000).toFixed(3)}s`,
    );
  };

  if (process.env.PARALLEL_SUBMIT === "1") {
    const requests = await Promise.all(
      Array.from({ length: concurrency }, (_, offset) => {
        const index = offset + 1;
        trace(`[${protocol}] before parallel submit index=${index}/${concurrency}`);
        return adapter.submit(index);
      }),
    );
    for (const request of requests.sort((a, b) => a.index - b.index)) {
      registerSubmission(request);
    }
  } else {
    for (let index = 1; index <= concurrency; index++) {
    trace(`[${protocol}] before submit index=${index}/${concurrency}`);
    const request = await adapter.submit(index);
    trace(`[${protocol}] after submit index=${index}/${concurrency} id=${request.id}`);
    registerSubmission(request);
    if (submitGapMs > 0 && index < concurrency) {
      await sleep(submitGapMs);
    }
    }
  }

  const pollStartedAtMs = Date.now();
  while (Date.now() - pollStartedAtMs < timeoutSeconds * 1000) {
    let terminalCount = 0;
    for (const request of submitted) {
      const sample = samples.get(request.id)!;
      if (sample.terminal) {
        terminalCount++;
        continue;
      }
      const status = await withRetry(`[${protocol}][${request.index}] poll`, () => adapter.poll(request));
      if (status.terminal) {
        const observedAtMs = Date.now();
        const latencyMs = observedAtMs - request.submitStartedAtMs;
        samples.set(request.id, {
          ...sample,
          terminal: true,
          completed: status.completed,
          rolledBack: status.rolledBack,
          timedOut: false,
          finalStatus: status.finalStatus,
          finalBlock: status.finalBlock,
          observedAtMs,
          latencyMs,
          latencySeconds: latencyMs / 1000,
        });
        terminalCount++;
        console.log(
          `[RQ3c][${protocol}] terminal id=${request.id} status=${status.finalStatus} completed=${status.completed} latency=${(latencyMs / 1000).toFixed(3)}s`,
        );
      }
    }
    if (terminalCount === submitted.length) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  const benchmarkEndedAtMs = Date.now();
  const finalSamples = submitted.map((request) => {
    const sample = samples.get(request.id)!;
    if (sample.terminal) {
      return sample;
    }
    return {
      ...sample,
      timedOut: true,
      observedAtMs: benchmarkEndedAtMs,
      latencyMs: benchmarkEndedAtMs - request.submitStartedAtMs,
      latencySeconds: (benchmarkEndedAtMs - request.submitStartedAtMs) / 1000,
    };
  });
  const summary = summarize(finalSamples);
  const result = {
    schemaVersion: 1,
    rq: "RQ3c",
    protocol,
    mode: adapter.mode,
    workload: {
      depth,
      concurrency,
      contention,
      hotLockFraction,
      overlap: "all requests reuse the same benchmark service/state set for the selected depth",
      submission: "back-to-back burst from one signer; protocol completion is overlapped",
    },
    timing: {
      startedAt: new Date(benchmarkStartedAtMs).toISOString(),
      endedAt: new Date(benchmarkEndedAtMs).toISOString(),
      elapsedSeconds: (benchmarkEndedAtMs - benchmarkStartedAtMs) / 1000,
      timeoutSeconds,
      pollIntervalMs,
      submitGapMs,
    },
    summary,
    samples: finalSamples,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results", "rq3");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath =
    outputOverride.trim() !== ""
      ? path.resolve(outputOverride)
      : path.join(outputDir, `concurrency-${protocol}-d${depth}-c${concurrency}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved RQ3c results to ${outputPath}`);
  console.log(summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
