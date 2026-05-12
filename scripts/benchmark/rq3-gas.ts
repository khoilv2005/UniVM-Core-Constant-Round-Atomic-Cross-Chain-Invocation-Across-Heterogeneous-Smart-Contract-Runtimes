/**
 * RQ3b gas profiler.
 *
 * Measures homogeneous-EVM all-chain gas for one protocol/depth by:
 * 1. submitting one CCSCI request,
 * 2. waiting for the protocol terminal state,
 * 3. scanning bc1/bc2/bc3 blocks over the request timestamp window,
 * 4. collecting receipts touching the protocol's contracts on each chain, and
 * 5. grouping gas by coarse protocol phase.
 *
 * The script measures all EVM chains used by the homogeneous benchmark. It does
 * not measure WASM/Fabric fees used by heterogeneous RQ1c.
 *
 * Usage:
 *   $env:PROTOCOL="xsmart"; $env:DEPTH="3"; $env:RUNS="1"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-gas.ts --network besu
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Protocol = "xsmart" | "integratex" | "gpact" | "atom";
type ChainName = "bc1" | "bc2" | "bc3";

type Deployment = {
  contracts: Record<string, string>;
};

type SubmittedRun = {
  id: string;
  run: number;
  startBlock: number;
  submitStartedAtMs: number;
  submittedAtMs: number;
  userTxHashes: string[];
};

type TerminalState = {
  terminal: boolean;
  completed: boolean;
  rolledBack: boolean;
  finalStatus: number | string | null;
  finalBlock: number | null;
};

type ProtocolAdapter = {
  protocol: Protocol;
  mode: string;
  watchedByChain: Record<ChainName, Record<string, string>>;
  submit: (run: number) => Promise<SubmittedRun>;
  poll: (request: SubmittedRun) => Promise<TerminalState>;
};

type GasTx = {
  chain: ChainName;
  scannedChain: ChainName;
  hash: string;
  blockNumber: number;
  from: string;
  to: string | null;
  toLabel: string;
  gasUsed: string;
  gasUsedNumber: number;
  effectiveGasPrice: string | null;
  feeWei: string | null;
  functionName: string | null;
  eventNames: string[];
  category: string;
  paperCategory: "bridge_gas" | "state_lock_unlock_gas" | "integrated_execution_gas";
};

type GasRun = {
  run: number;
  id: string;
  completed: boolean;
  rolledBack: boolean;
  finalStatus: number | string | null;
  startBlock: number;
  finalBlock: number;
  latencyMs: number;
  latencySeconds: number;
  totalGas: number;
  categoryGas: Record<string, number>;
  paperCategoryGas: Record<string, number>;
  chainGas: Record<ChainName, number>;
  transactions: GasTx[];
};

const FUNCTION_FRAGMENTS = [
  "function requestLockStates(uint256,string,address[],uint256,uint256)",
  "function executeIntegratedLogic(uint256,string,bytes[])",
  "function executeIntegratedCallTree(uint256,string,bytes,bytes32[],bytes32[])",
  "function initiateExecution(uint256,uint256,uint256)",
  "function startLocking(uint256,address[],uint256[])",
  "function startBooking(bytes32,uint256,uint256,uint256,uint256)",
  "function invokeWriteOnlyDepth(bytes32,uint256,uint256,uint256,uint256)",
  "function receiveLockRequest(uint256,address[],uint256[])",
  "function receiveUpdateRequest(uint256,bool)",
  "function receiveRollbackRequest(uint256)",
  "function completeExecution(uint256,bool)",
  "function submitProof(bytes32,bytes32,bytes)",
  "function submitVote(bytes32,bool,bytes)",
  "function settle(bytes32)",
  "function root(bytes32,bytes32,uint256)",
  "function segment(bytes32,bytes32,uint256)",
  "function signalling(bytes32,bool)",
  "function abortOnTimeout(bytes32)",
];

const EVENT_FRAGMENTS = [
  "event ExecutionCompleted(uint256 indexed crossChainTxId,address indexed initiator)",
  "event CallTreeNodeExecuted(uint256 indexed crossChainTxId,uint256 indexed nodeIndex,address indexed contractAddr,bytes result)",
  "event CrossChainExecutionInitiated(uint256 indexed crossChainTxId,address indexed initiator)",
  "event CrossChainExecutionCompleted(uint256 indexed crossChainTxId,bool success)",
  "event CrossChainExecutionCompleted(uint256 indexed crossChainTxId)",
  "event IntegratedExecutionCompleted(uint256 indexed crossChainTxId,uint256 totalCost,uint256 depth)",
  "event IntegratedExecutionPerformed(uint256 indexed crossChainTxId,string serviceId,address logicContract,bytes resultHash)",
  "event CrossChainLockRequested(uint256 indexed crossChainTxId,address[] stateContracts,uint256 executionChainId)",
  "event CrossChainLockRequested(uint256 indexed crossChainTxId,string serviceId,address[] stateContracts,uint256 destChainId)",
  "event CrossChainLockResponse(uint256 indexed crossChainTxId,bool success)",
  "event CrossChainLockResponse(uint256 indexed crossChainTxId,address indexed stateContract,bytes stateData)",
  "event UpdatingPhaseStarted(uint256 indexed crossChainTxId)",
  "event LockingPhaseStarted(uint256 indexed crossChainTxId,address[] stateContracts,uint256[] chainIds)",
  "event LockingPhaseCompleted(uint256 indexed crossChainTxId)",
  "event LockResponseReceived(uint256 indexed crossChainTxId,uint256 indexed stateIndex,uint256 chainId,bytes stateData)",
  "event UpdateAckReceived(uint256 indexed crossChainTxId,address stateContract)",
  "event UpdatingPhaseCompleted(uint256 indexed crossChainTxId)",
  "event CrossChainUpdateAck(uint256 indexed crossChainTxId,bool success)",
  "event CrossChainUpdateAck(uint256 indexed crossChainTxId,address indexed stateContract,bool success)",
  "event CrossChainRollback(uint256 indexed crossChainTxId)",
  "event BookingStarted(bytes32 indexed crosschainTxId,address indexed user,uint256 rooms,uint256 outbound,uint256 returnTickets)",
  "event StartEvent(bytes32 indexed crosschainTxId,uint256 indexed rootChainId,bytes32 callTreeHash,uint256 timeoutBlock)",
  "event SegmentEvent(bytes32 indexed crosschainTxId,uint256 indexed chainId,uint256 indexed segmentId,bytes32 callTreeHash,bool success,bool locked,bytes result)",
  "event RootEvent(bytes32 indexed crosschainTxId,uint256 indexed rootChainId,bytes32 callTreeHash,bool commit,bool abortTx)",
  "event SignallingEvent(bytes32 indexed crosschainTxId,uint256 indexed chainId,uint256 indexed segmentId,bool commit)",
  "event WriteOnlyInvocationRequested(bytes32 indexed invokeId,bytes32 indexed workflowId,address indexed user,uint256 totalOperationCount)",
  "event ReadWriteInvocationRequested(bytes32 indexed invokeId,bytes32 indexed workflowId,address indexed user,uint256 totalOperationCount)",
];

const gasInterface = new ethers.Interface([...FUNCTION_FRAGMENTS, ...EVENT_FRAGMENTS]);

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

function rpcUrlForChain(chain: ChainName): string {
  const envValue = process.env[`${chain.toUpperCase()}_RPC_URL`];
  if (envValue && envValue.trim() !== "") return envValue;
  if (chain === "bc1") return "http://209.38.21.129:8545";
  if (chain === "bc2") return "http://170.64.194.4:8545";
  return "http://170.64.164.173:8545";
}

function providersByChain(): Record<ChainName, ethers.JsonRpcProvider> {
  return {
    bc1: new ethers.JsonRpcProvider(rpcUrlForChain("bc1")),
    bc2: new ethers.JsonRpcProvider(rpcUrlForChain("bc2")),
    bc3: new ethers.JsonRpcProvider(rpcUrlForChain("bc3")),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lowerAddress(value: string | null | undefined): string {
  return value ? value.toLowerCase() : "";
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
      console.log(`[RQ3b][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
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
  return { stateContracts, chainIds };
}

async function ensureTranslatedBenchmarkState(translatedAddress: string) {
  const translated: any = await ethers.getContractAt("HotelBookingTranslated", translatedAddress);
  const price = await translated.GetPrice();
  if (price !== 0n) return;
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

async function buildXSmartAdapter(depth: number): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("xsmart", "bc1-1a");
  const bc2 = loadDeployment("xsmart", "bc2-evm");
  const bc3 = loadDeployment("xsmart", "bc3-evm");
  const bridge: any = await ethers.getContractAt("XBridgingContract", bc1.contracts.xBridgingContract);
  await ensureTranslatedBenchmarkState(bc1.contracts.hotelBookingTranslated);
  const stateContracts = selectedXSmartStateContracts(depth, bc2, bc3);
  const watchedByChain = {
    bc1: {
      xBridgingContract: bc1.contracts.xBridgingContract,
      ubtlRegistry: bc1.contracts.ubtlRegistry,
      hotelBookingTranslated: bc1.contracts.hotelBookingTranslated,
      lHotel: bc1.contracts.lHotel,
      lTrain: bc1.contracts.lTrain,
      sHotel: bc1.contracts.sHotel,
      sTrain: bc1.contracts.sTrain,
    },
    bc2: {
      xBridgingContract: bc2.contracts.xBridgingContract,
      ubtlRegistry: bc2.contracts.ubtlRegistry,
      sHotel: bc2.contracts.sHotel,
      sFlight: bc2.contracts.sFlight,
      sTrain: bc2.contracts.sTrain,
      lHotel: bc2.contracts.lHotel,
      lFlight: bc2.contracts.lFlight,
    },
    bc3: {
      xBridgingContract: bc3.contracts.xBridgingContract,
      ubtlRegistry: bc3.contracts.ubtlRegistry,
      sTrain: bc3.contracts.sTrain,
      sTaxi: bc3.contracts.sTaxi,
      sHotel: bc3.contracts.sHotel,
      lTrain: bc3.contracts.lTrain,
      lTaxi: bc3.contracts.lTaxi,
    },
  };

  return {
    protocol: "xsmart",
    mode: "gas-homogeneous-evm",
    watchedByChain,
    submit: async (run: number) => {
      const txId = BigInt(Date.now()) * 1000n + BigInt(depth * 10 + run);
      const submitStartedAtMs = Date.now();
      const fee = await bridge.crossChainFee();
      const tx: any = await withRetry(`[xsmart][run=${run}] requestLockStates`, () =>
        bridge.requestLockStates(txId, "travel", stateContracts, 30n, 2n, { value: fee }),
      );
      const receipt: any = await withRetry(`[xsmart][run=${run}] wait requestLockStates`, () => tx.wait());
      return {
        id: txId.toString(),
        run,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs: Date.now(),
        userTxHashes: [receipt!.hash],
      };
    },
    poll: async (request: SubmittedRun) => {
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
  const watchedByChain = {
    bc1: {
      bridgingContract: bc1.contracts.bridgingContract,
      travelDApp: bc1.contracts.travelDApp,
      travelDepthDApp: bc1.contracts.travelDepthDApp,
      lHotel: bc1.contracts.lHotel,
      lTrain: bc1.contracts.lTrain,
      lFlight: bc1.contracts.lFlight,
    },
    bc2: {
      bridgingContract: bc2.contracts.bridgingContract,
      sHotel: bc2.contracts.sHotel,
      sFlight: bc2.contracts.sFlight,
      lHotel: bc2.contracts.lHotel,
      lFlight: bc2.contracts.lFlight,
    },
    bc3: {
      bridgingContract: bc3.contracts.bridgingContract,
      sTrain: bc3.contracts.sTrain,
      sTaxi: bc3.contracts.sTaxi,
      lTrain: bc3.contracts.lTrain,
      lTaxi: bc3.contracts.lTaxi,
    },
  };

  return {
    protocol: "integratex",
    mode: "gas-homogeneous-evm",
    watchedByChain,
    submit: async (run: number) => {
      const initiateTx: any = await withRetry(`[integratex][run=${run}] initiateExecution`, () =>
        travelDApp.initiateExecution(1, 1, 1),
      );
      const initiateReceipt: any = await withRetry(`[integratex][run=${run}] wait initiateExecution`, () =>
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
      const lockTx: any = await withRetry(`[integratex][run=${run}] startLocking`, () =>
        travelDApp.startLocking(txId, stateContracts, chainIds),
      );
      const lockReceipt: any = await withRetry(`[integratex][run=${run}] wait startLocking`, () => lockTx.wait());
      return {
        id: String(txId),
        run,
        startBlock: initiateReceipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs: Date.now(),
        userTxHashes: [initiateReceipt!.hash, lockReceipt!.hash],
      };
    },
    poll: async (request: SubmittedRun) => {
      const status = Number(await travelDApp.getExecutionStatus(Number(request.id)));
      if (status !== 7 && status !== 8) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      return {
        terminal: true,
        completed: status === 7,
        rolledBack: status === 8,
        finalStatus: status,
        finalBlock: await ethers.provider.getBlockNumber(),
      };
    },
  };
}

async function buildGPACTAdapter(): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("gpact", "bc1");
  const bc2 = loadDeployment("gpact", "bc2");
  const bc3 = loadDeployment("gpact", "bc3");
  const travelRoot: any = await ethers.getContractAt(
    "GPACTTravelRoot",
    bc1.contracts.gpactTravelRoot ?? bc1.contracts.travelRoot,
  );
  const control: any = await ethers.getContractAt(
    "GPACTCrosschainControl",
    bc1.contracts.gpactCrosschainControl ?? bc1.contracts.crosschainControl,
  );
  const watchedByChain = {
    bc1: {
      gpactTravelRoot: bc1.contracts.gpactTravelRoot ?? bc1.contracts.travelRoot,
      gpactCrosschainControl: bc1.contracts.gpactCrosschainControl ?? bc1.contracts.crosschainControl,
      gpactSignerRegistry: bc1.contracts.gpactSignerRegistry,
    },
    bc2: {
      gpactCrosschainControl: bc2.contracts.gpactCrosschainControl,
      gpactSignerRegistry: bc2.contracts.gpactSignerRegistry,
      gpactHotel: bc2.contracts.gpactHotel,
      gpactFlight: bc2.contracts.gpactFlight,
    },
    bc3: {
      gpactCrosschainControl: bc3.contracts.gpactCrosschainControl,
      gpactSignerRegistry: bc3.contracts.gpactSignerRegistry,
      gpactTrain: bc3.contracts.gpactTrain,
      gpactTaxi: bc3.contracts.gpactTaxi,
    },
  };

  return {
    protocol: "gpact",
    mode: "gas-homogeneous-evm",
    watchedByChain,
    submit: async (run: number) => {
      const txId = ethers.keccak256(ethers.toUtf8Bytes(`rq3b-gpact-${run}-${Date.now()}`));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[gpact][run=${run}] startBooking`, () =>
        travelRoot.startBooking(txId, 1, 1, 1, 99999999),
      );
      const receipt: any = await withRetry(`[gpact][run=${run}] wait startBooking`, () => tx.wait());
      return {
        id: txId,
        run,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs: Date.now(),
        userTxHashes: [receipt!.hash],
      };
    },
    poll: async (request: SubmittedRun) => {
      const status = Number(await control.txStatus(request.id));
      if (status !== 5 && status !== 6) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      return {
        terminal: true,
        completed: status === 5,
        rolledBack: status === 6,
        finalStatus: status,
        finalBlock: await ethers.provider.getBlockNumber(),
      };
    },
  };
}

async function buildATOMAdapter(depth: number, invokeGasLimit: bigint): Promise<ProtocolAdapter> {
  const bc1 = loadDeployment("atom", "bc1");
  const bc2 = loadDeployment("atom", "bc2");
  const bc3 = loadDeployment("atom", "bc3");
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
  const watchedByChain = {
    bc1: {
      atomCommunity: bc1.contracts.atomCommunity,
      atomService: bc1.contracts.atomService,
      atomRemoteRegistry: bc1.contracts.atomRemoteRegistry,
      atomTravelEntry: bc1.contracts.atomTravelEntry,
      atomTravelDepthEntry: bc1.contracts.atomTravelDepthEntry,
    },
    bc2: {
      atomHotel: bc2.contracts.atomHotel,
      atomFlight: bc2.contracts.atomFlight,
    },
    bc3: {
      atomTrain: bc3.contracts.atomTrain,
      atomTaxi: bc3.contracts.atomTaxi,
    },
  };

  return {
    protocol: "atom",
    mode: "gas-homogeneous-evm",
    watchedByChain,
    submit: async (run: number) => {
      const invokeId = ethers.keccak256(ethers.toUtf8Bytes(`rq3b-atom-depth-${depth}-${run}-${Date.now()}`));
      const totalOperationCount = BigInt(Math.max(1, depth - 1));
      const submitStartedAtMs = Date.now();
      const tx: any = await withRetry(`[atom][run=${run}] invokeWriteOnlyDepth`, () =>
        entry.invokeWriteOnlyDepth(invokeId, totalOperationCount, 1, 1, 1, { gasLimit: invokeGasLimit }),
      );
      const receipt: any = await withRetry(`[atom][run=${run}] wait invokeWriteOnlyDepth`, () => tx.wait());
      return {
        id: invokeId,
        run,
        startBlock: receipt!.blockNumber,
        submitStartedAtMs,
        submittedAtMs: Date.now(),
        userTxHashes: [receipt!.hash],
      };
    },
    poll: async (request: SubmittedRun) => {
      const invocation = await service.getInvocation(request.id);
      const status = Number(invocation.status);
      if (status !== 7 && status !== 8) {
        return { terminal: false, completed: false, rolledBack: false, finalStatus: status, finalBlock: null };
      }
      return {
        terminal: true,
        completed: status === 7,
        rolledBack: status === 8,
        finalStatus: status,
        finalBlock: await ethers.provider.getBlockNumber(),
      };
    },
  };
}

function functionNameFromInput(input: string | undefined): string | null {
  if (!input || input === "0x") return null;
  try {
    return gasInterface.parseTransaction({ data: input })?.name ?? null;
  } catch {
    return null;
  }
}

function eventNamesFromReceipt(receipt: any): string[] {
  const names: string[] = [];
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = gasInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name) names.push(parsed.name);
    } catch {
      // Not all logs belong to our minimal ABI. Unknown logs are still kept in
      // raw transaction data through the watched-address filter.
    }
  }
  return [...new Set(names)];
}

function classifyGasTx(
  protocol: Protocol,
  chain: ChainName,
  txHash: string,
  userTxHashes: Set<string>,
  toLabel: string,
  functionName: string | null,
  eventNames: string[],
): string {
  if (chain !== "bc1") {
    if (eventNames.some((name) => name.includes("Lock"))) return "remote_lock";
    if (eventNames.some((name) => name.includes("Update") || name.includes("Ack"))) return "remote_update";
    if (eventNames.some((name) => name.includes("Rollback"))) return "remote_rollback";
    if (protocol === "gpact") return "remote_gpact_segment";
    if (protocol === "atom") return "remote_atom_service";
    return "remote_state";
  }
  if (userTxHashes.has(txHash.toLowerCase())) {
    if (functionName === "initiateExecution") return "user_prepare";
    return "user_submission";
  }
  if (eventNames.some((name) => name.includes("CallTreeNodeExecuted"))) return "integrated_execution";
  if (eventNames.some((name) => name.includes("ExecutionCompleted"))) return "finalization";
  if (eventNames.some((name) => name.includes("Rollback"))) return "rollback";
  if (eventNames.some((name) => name.includes("Lock") || name.includes("Update") || name.includes("Ack"))) {
    return "lock_update_control";
  }
  if (protocol === "gpact") {
    if (functionName === "root" || functionName === "segment" || functionName === "signalling") return "gpact_control";
    if (toLabel.toLowerCase().includes("control")) return "gpact_control";
  }
  if (protocol === "atom") {
    if (toLabel.toLowerCase().includes("service") || toLabel.toLowerCase().includes("community")) {
      return "audit_settlement";
    }
  }
  return "protocol_control";
}

function paperCategoryForTx(
  protocol: Protocol,
  chain: ChainName,
  category: string,
  toLabel: string,
  functionName: string | null,
  eventNames: string[],
): GasTx["paperCategory"] {
  if (category.startsWith("remote_")) {
    return "state_lock_unlock_gas";
  }
  if (
    category === "integrated_execution" ||
    functionName === "executeIntegratedLogic" ||
    functionName === "executeIntegratedCallTree" ||
    eventNames.some((name) =>
      ["CallTreeNodeExecuted", "IntegratedExecutionPerformed", "IntegratedExecutionCompleted"].includes(name),
    )
  ) {
    return "integrated_execution_gas";
  }
  if (protocol === "gpact" && eventNames.some((name) => name === "RootEvent")) {
    return "integrated_execution_gas";
  }
  if (protocol === "integratex" && eventNames.some((name) => name === "UpdatingPhaseStarted")) {
    // In CrossChainTravelDepthDApp, _proceedToExecution emits
    // IntegratedExecutionCompleted, LockingPhaseCompleted, then UpdatingPhaseStarted
    // in the same tx. Treat this tx as integrated execution even if the local
    // minimal ABI only decodes UpdatingPhaseStarted.
    return "integrated_execution_gas";
  }
  if (chain === "bc1" && toLabel.toLowerCase().includes("traveldepthdapp") && category === "protocol_control") {
    return "bridge_gas";
  }
  return "bridge_gas";
}

function prefixedWatchedAddresses(
  watchedByChain: Record<ChainName, Record<string, string>>,
): Record<ChainName, Record<string, string>> {
  return {
    bc1: Object.fromEntries(Object.entries(watchedByChain.bc1).map(([label, address]) => [`bc1.${label}`, address])),
    bc2: Object.fromEntries(Object.entries(watchedByChain.bc2).map(([label, address]) => [`bc2.${label}`, address])),
    bc3: Object.fromEntries(Object.entries(watchedByChain.bc3).map(([label, address]) => [`bc3.${label}`, address])),
  };
}

function mergeWatchedAddresses(chains: ChainName[], watchedByChain: Record<ChainName, Record<string, string>>) {
  const merged: Record<string, string> = {};
  for (const chain of chains) {
    for (const [label, address] of Object.entries(watchedByChain[chain])) {
      if (address) merged[label] = address;
    }
  }
  return merged;
}

function inferLogicalChain(scannedChain: ChainName, label: string): ChainName {
  if (label.startsWith("bc1.")) return "bc1";
  if (label.startsWith("bc2.")) return "bc2";
  if (label.startsWith("bc3.")) return "bc3";
  return scannedChain;
}

async function chainFingerprint(provider: ethers.Provider): Promise<string> {
  const network = await provider.getNetwork();
  const genesis = await provider.getBlock(0);
  return `${network.chainId.toString()}:${genesis?.hash ?? "unknown"}`;
}

async function blockTimestamp(provider: ethers.Provider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
}

async function firstBlockAtOrAfter(provider: ethers.Provider, targetTimestamp: number): Promise<number> {
  const latest = await provider.getBlockNumber();
  const latestTs = await blockTimestamp(provider, latest);
  if (latestTs < targetTimestamp) return latest;
  let left = 0;
  let right = latest;
  let answer = latest;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const ts = await blockTimestamp(provider, mid);
    if (ts >= targetTimestamp) {
      answer = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return answer;
}

async function lastBlockAtOrBefore(provider: ethers.Provider, targetTimestamp: number): Promise<number> {
  const latest = await provider.getBlockNumber();
  const latestTs = await blockTimestamp(provider, latest);
  if (latestTs <= targetTimestamp) return latest;
  let left = 0;
  let right = latest;
  let answer = 0;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const ts = await blockTimestamp(provider, mid);
    if (ts <= targetTimestamp) {
      answer = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return answer;
}

async function scanChainGas(
  protocol: Protocol,
  scannedChain: ChainName,
  provider: ethers.Provider,
  request: SubmittedRun,
  fromBlock: number,
  toBlock: number,
  watchedAddresses: Record<string, string>,
): Promise<GasTx[]> {
  const addressToLabel = new Map<string, string>();
  for (const [label, address] of Object.entries(watchedAddresses)) {
    if (address) addressToLabel.set(address.toLowerCase(), label);
  }
  const watched = new Set(addressToLabel.keys());
  const userTxHashes = new Set(request.userTxHashes.map((hash) => hash.toLowerCase()));
  const gasTxs: GasTx[] = [];

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const block = await withRetry(`${scannedChain} block ${blockNumber}`, () =>
      provider.send("eth_getBlockByNumber", [ethers.toBeHex(blockNumber), true]),
    );
    for (const tx of block.transactions ?? []) {
      const txHash = String(tx.hash);
      const to = tx.to ? String(tx.to) : null;
      const toLower = lowerAddress(to);
      const receipt: any = await withRetry(`${scannedChain} receipt ${txHash}`, () =>
        provider.getTransactionReceipt(txHash),
      );
      const touchesWatched =
        watched.has(toLower) ||
        (receipt.logs ?? []).some((log: any) => watched.has(lowerAddress(log.address))) ||
        userTxHashes.has(txHash.toLowerCase());
      if (!touchesWatched) continue;

      const logLabel =
        (receipt.logs ?? [])
          .map((log: any) => addressToLabel.get(lowerAddress(log.address)))
          .find((label: string | undefined) => label !== undefined) ?? null;
      const toLabel = addressToLabel.get(toLower) ?? logLabel ?? "unknown";
      const logicalChain = inferLogicalChain(scannedChain, toLabel);
      const functionName = functionNameFromInput(tx.input);
      const eventNames = eventNamesFromReceipt(receipt);
      const gasUsed = BigInt(receipt.gasUsed);
      const effectiveGasPrice = receipt.effectiveGasPrice == null ? null : BigInt(receipt.effectiveGasPrice);
      const feeWei = effectiveGasPrice == null ? null : gasUsed * effectiveGasPrice;
      const category = classifyGasTx(protocol, logicalChain, txHash, userTxHashes, toLabel, functionName, eventNames);
      const paperCategory = paperCategoryForTx(protocol, logicalChain, category, toLabel, functionName, eventNames);

      gasTxs.push({
        chain: logicalChain,
        scannedChain,
        hash: txHash,
        blockNumber,
        from: String(tx.from),
        to,
        toLabel,
        gasUsed: gasUsed.toString(),
        gasUsedNumber: Number(gasUsed),
        effectiveGasPrice: effectiveGasPrice == null ? null : effectiveGasPrice.toString(),
        feeWei: feeWei == null ? null : feeWei.toString(),
        functionName,
        eventNames,
        category,
        paperCategory,
      });
    }
  }

  return gasTxs;
}

async function scanAllChainGas(
  protocol: Protocol,
  request: SubmittedRun,
  finalBlock: number,
  finalTimestamp: number,
  watchedByChain: Record<ChainName, Record<string, string>>,
  scanMarginSeconds: number,
): Promise<GasTx[]> {
  const providers = providersByChain();
  const prefixedWatched = prefixedWatchedAddresses(watchedByChain);
  const startTimestamp = await blockTimestamp(providers.bc1, request.startBlock);
  const allGasTxs: GasTx[] = [];
  const groups = new Map<string, ChainName[]>();
  for (const chain of ["bc1", "bc2", "bc3"] as ChainName[]) {
    const fingerprint = await chainFingerprint(providers[chain]);
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), chain]);
  }

  for (const chains of groups.values()) {
    const scanChain = chains.includes("bc1") ? "bc1" : chains[0];
    const provider = providers[scanChain];
    const fromBlock = chains.includes("bc1")
      ? request.startBlock
      : await firstBlockAtOrAfter(provider, Math.max(0, startTimestamp - scanMarginSeconds));
    const toBlock = chains.includes("bc1")
      ? finalBlock
      : await lastBlockAtOrBefore(provider, finalTimestamp + scanMarginSeconds);
    const watched = mergeWatchedAddresses(chains, prefixedWatched);
    const chainGasTxs = await scanChainGas(protocol, scanChain, provider, request, fromBlock, toBlock, watched);
    allGasTxs.push(...chainGasTxs);
  }
  return allGasTxs;
}

function summarizeRuns(runs: GasRun[]) {
  const totalGasValues = runs.map((run) => run.totalGas);
  const avgTotalGas =
    totalGasValues.length === 0 ? 0 : totalGasValues.reduce((total, value) => total + value, 0) / totalGasValues.length;
  const categories = new Set<string>();
  const paperCategories = new Set<string>();
  const chains = new Set<ChainName>();
  for (const run of runs) {
    for (const category of Object.keys(run.categoryGas)) categories.add(category);
    for (const category of Object.keys(run.paperCategoryGas)) paperCategories.add(category);
    for (const chain of Object.keys(run.chainGas) as ChainName[]) chains.add(chain);
  }
  const avgCategoryGas: Record<string, number> = {};
  for (const category of [...categories].sort()) {
    const values = runs.map((run) => run.categoryGas[category] ?? 0);
    avgCategoryGas[category] = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  }
  const avgPaperCategoryGas: Record<string, number> = {};
  for (const category of [...paperCategories].sort()) {
    const values = runs.map((run) => run.paperCategoryGas[category] ?? 0);
    avgPaperCategoryGas[category] =
      values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  }
  const avgChainGas: Record<string, number> = {};
  for (const chain of [...chains].sort()) {
    const values = runs.map((run) => run.chainGas[chain] ?? 0);
    avgChainGas[chain] = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  }
  return {
    runs: runs.length,
    completed: runs.filter((run) => run.completed).length,
    rolledBack: runs.filter((run) => run.rolledBack).length,
    avgTotalGas,
    avgCategoryGas,
    avgPaperCategoryGas,
    avgChainGas,
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
    throw new Error(`RQ3b gas benchmark must run with a bc1/besu config, got network=${network.name}`);
  }

  const protocol = getArg("protocol", "xsmart").toLowerCase() as Protocol;
  if (!["xsmart", "integratex", "gpact", "atom"].includes(protocol)) {
    throw new Error(`Unsupported PROTOCOL=${protocol}`);
  }
  const depth = Number(getArg("depth", "3"));
  const runs = Number(getArg("runs", "1"));
  const timeoutSeconds = Number(getArg("timeout", "360"));
  const pollIntervalMs = Number(getArg("poll-interval-ms", "250"));
  const runDelayMs = Number(getArg("run-delay-ms", "3000"));
  const scanMarginSeconds = Number(getArg("scan-margin-seconds", "15"));
  const invokeGasLimit = BigInt(getArg("invoke-gas-limit", "800000"));
  const outputOverride = getArg("out", "");
  const dryRun = getArg("dry-run", "0") === "1";
  if (![2, 3, 4].includes(depth)) {
    throw new Error(`RQ3b DEPTH must be one of 2,3,4; got ${depth}`);
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`RUNS must be a positive integer, got ${runs}`);
  }
  if (dryRun) {
    console.log(`[RQ3b][dry-run] protocol=${protocol} runs=${runs} depth=${depth}`);
    return;
  }

  const adapter = await buildAdapter(protocol, depth, invokeGasLimit);
  const gasRuns: GasRun[] = [];
  for (let run = 1; run <= runs; run++) {
    console.log(`[RQ3b][${protocol}] run=${run}/${runs} depth=${depth} submitting`);
    const submitted = await adapter.submit(run);
    const pollStartedAtMs = Date.now();
    let terminal: TerminalState = {
      terminal: false,
      completed: false,
      rolledBack: false,
      finalStatus: null,
      finalBlock: null,
    };
    while (Date.now() - pollStartedAtMs < timeoutSeconds * 1000) {
      terminal = await withRetry(`[${protocol}][run=${run}] poll`, () => adapter.poll(submitted));
      if (terminal.terminal) break;
      await sleep(pollIntervalMs);
    }
    if (!terminal.terminal || terminal.finalBlock == null) {
      throw new Error(`[RQ3b][${protocol}] run=${run} id=${submitted.id} did not finish within ${timeoutSeconds}s`);
    }
    const observedAtMs = Date.now();
    const finalTimestamp = await blockTimestamp(ethers.provider, terminal.finalBlock);
    const transactions = await scanAllChainGas(
      protocol,
      submitted,
      terminal.finalBlock,
      finalTimestamp,
      adapter.watchedByChain,
      scanMarginSeconds,
    );
    const categoryGas: Record<string, number> = {};
    const paperCategoryGas: Record<string, number> = {
      bridge_gas: 0,
      state_lock_unlock_gas: 0,
      integrated_execution_gas: 0,
    };
    const chainGas: Record<ChainName, number> = { bc1: 0, bc2: 0, bc3: 0 };
    let totalGas = 0;
    for (const tx of transactions) {
      totalGas += tx.gasUsedNumber;
      categoryGas[tx.category] = (categoryGas[tx.category] ?? 0) + tx.gasUsedNumber;
      paperCategoryGas[tx.paperCategory] = (paperCategoryGas[tx.paperCategory] ?? 0) + tx.gasUsedNumber;
      chainGas[tx.chain] = (chainGas[tx.chain] ?? 0) + tx.gasUsedNumber;
    }
    const gasRun: GasRun = {
      run,
      id: submitted.id,
      completed: terminal.completed,
      rolledBack: terminal.rolledBack,
      finalStatus: terminal.finalStatus,
      startBlock: submitted.startBlock,
      finalBlock: terminal.finalBlock,
      latencyMs: observedAtMs - submitted.submitStartedAtMs,
      latencySeconds: (observedAtMs - submitted.submitStartedAtMs) / 1000,
      totalGas,
      categoryGas,
      paperCategoryGas,
      chainGas,
      transactions,
    };
    gasRuns.push(gasRun);
    console.log(
      `[RQ3b][${protocol}] run=${run} status=${terminal.finalStatus} totalGas=${totalGas} categories=${JSON.stringify(categoryGas)}`,
    );
    if (run < runs) await sleep(runDelayMs);
  }

  const result = {
    schemaVersion: 1,
    rq: "RQ3b",
    protocol,
    mode: adapter.mode,
    depth,
    scope: "homogeneous-evm-all-chain-gas-bc1-bc2-bc3",
    note:
      "All-chain EVM gas sums receipts on bc1, bc2, and bc3 that touch watched protocol contracts within the request timestamp window.",
    scanMarginSeconds,
    summary: summarizeRuns(gasRuns),
    runs: gasRuns,
  };

  const outputDir = path.join(__dirname, "..", "..", "benchmark-results", "rq3");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath =
    outputOverride.trim() !== ""
      ? path.resolve(outputOverride)
      : path.join(outputDir, `gas-${protocol}-d${depth}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Saved RQ3b gas results to ${outputPath}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
