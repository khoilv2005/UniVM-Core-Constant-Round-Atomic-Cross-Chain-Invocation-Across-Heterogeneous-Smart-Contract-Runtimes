import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { execFileSync, spawn, ChildProcess } from "child_process";
import { ethers } from "ethers";
import { Timer } from "./lib/timer";
import {
  PRIVATE_KEYS,
  loadDeployment,
  repoRoot,
} from "../common";
import { ensureBC2RemoteDockerProxy, stopBC2RemoteDockerProxy } from "../xsmart/bc2-remote-proxy";
import { ensureLocalBC2Node, stopLocalBC2Node } from "../xsmart/local-bc2-node";
import { ensureLocalBC3Fabric, stopLocalBC3Fabric } from "../xsmart/local-bc3-fabric";

type Sample = {
  run: number;
  depth: number;
  txId: string;
  startBlock: number;
  finalBlock: number;
  latencySeconds: number;
  latencyMs: number;
  blockLatencySeconds: number;
  markerCount: number;
  jsonlPath: string;
};

type CheckpointAction = {
  tx_id?: string;
  source_event?: string;
  dest_chain?: string;
  status?: string;
};

type RelayerMarker = {
  ts?: string;
  protocol?: string;
  tx_id?: string;
  chain?: string;
  event?: string;
  phase?: string;
  block?: number;
  detail?: Record<string, unknown>;
};

const BC1_HTTP_URL = process.env.BC1_HTTP_URL || "http://209.38.21.129:8545";
const BC1_WS_URL = process.env.BC1_RPC_URL || process.env.BC1_WS_URL || "ws://209.38.21.129:8546";
const CHECKPOINT_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-ckpt.json");
const RELAYER_LOG_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-benchmark-relayer.log");
const RELAYER_CONFIG = path.resolve(getArg("relayer-config", path.join(repoRoot(), "configs", "relayer", "config-xsmart.yaml")));
const BC2_DEPLOY_FILE = path.join(repoRoot(), "deployments", "xsmart", "bc2.json");
const BC3_DEPLOY_FILE = path.join(repoRoot(), "deployments", "xsmart", "bc3.json");
const WASM_DAEMON_PORT = Number(process.env.XSMART_WASM_DAEMON_PORT || "18745");
const WASM_DAEMON_URL = `http://127.0.0.1:${WASM_DAEMON_PORT}`;
const USE_BC2_DOCKER_PROXY = process.env.XSMART_USE_BC2_DOCKER_PROXY === "1";

const bridgeAbi = [
  "function crossChainFee() external view returns (uint256)",
  "function requestLockStates(uint256 crossChainTxId, string serviceId, address[] stateContracts, uint256 timeoutBlocks, uint256 destChainId) external payable",
];
const translatedAbi = [
  "function __vassp_apply(bytes32 slot, bytes value) external",
];

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

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
}

function startRelayer(root: string, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const child = spawn(
    path.join(root, "relayer", "relayer.exe"),
    ["start", "--config", RELAYER_CONFIG],
    {
      cwd: path.join(root, "relayer"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    }
  );
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

function startWASMSubmitter(root: string, bc2Contracts: Record<string, string>): { child: ChildProcess; logs: string[]; url: string } {
  const logs: string[] = [];
  const tsNodeBin = path.join(root, "node_modules", "ts-node", "dist", "bin.js");
  const child = spawn(
    process.execPath,
    [tsNodeBin, "--project", "tsconfig.scripts.json", "scripts/xsmart/wasm-submit-daemon.ts"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XSMART_WASM_DAEMON_PORT: String(WASM_DAEMON_PORT),
        BC2_WASM_WS_URL: process.env.BC2_WASM_WS_URL || bc2Contracts.bc2RpcWs || "",
        XSMART_BC2_BRIDGE_CONTRACT: bc2Contracts.xBridgeBc2 || "",
        XSMART_BC2_BRIDGE_METADATA: bc2Contracts.bc2BridgeMetadataPath || "",
        XSMART_BC2_SURI: bc2Contracts.bc2SubmitterURI || "//Alice",
      },
    }
  );
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs, url: WASM_DAEMON_URL };
}

function buildRelayer(root: string) {
  if (process.env.XSMART_SKIP_RELAYER_BUILD === "1") {
    return;
  }
  run("go", ["build", "-o", "relayer.exe", "./cmd/relayer"], path.join(root, "relayer"));
}

function runRelayer(root: string, args: string[]): string {
  return run(
    path.join(root, "relayer", "relayer.exe"),
    args,
    path.join(root, "relayer")
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpHealth(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isRetryableRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const code = (error as { code?: string }).code;
  return (
    code === "NONCE_EXPIRED" ||
    code === "REPLACEMENT_UNDERPRICED" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    message.includes("nonce too low") ||
    message.includes("nonce has already been used") ||
    message.includes("replacement transaction underpriced") ||
    message.includes("replacement fee too low") ||
    message.includes("already known") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
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
      console.log(`[XSmart-RQ1c][retry] ${label} attempt=${attempt}/${attempts} failed: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function resetRelayerArtifacts(root: string) {
  const files = [
    path.join(root, "configs", "relayer", "var", "xsmart-ckpt.json"),
    path.join(root, "configs", "relayer", "var", "xsmart-smoke-prod-relayer.log"),
    path.join(root, "configs", "relayer", "var", "xsmart-benchmark-relayer.log"),
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") {
          throw error;
        }
        fs.writeFileSync(file, "", "utf-8");
      }
    }
  }
}

async function renderProdConfig(root: string, depth: number) {
  const renderScript = process.env.XSMART_RENDER_CONFIG_SCRIPT || "scripts/xsmart/render-config.ts";
  if (renderScript.includes("render-config-rq1c-depth")) {
    run(
      "npx",
      ["ts-node", "--project", "tsconfig.scripts.json", renderScript, "--depth", String(depth)],
      root,
      {
        BC1_HTTP_URL,
        BC1_RPC_URL: BC1_WS_URL,
      }
    );
    return;
  }

  const bc2 = loadDeployment("xsmart", "bc2");
  const bc3 = loadDeployment("xsmart", "bc3");
  run(
    "npx",
    ["ts-node", "--project", "tsconfig.scripts.json", renderScript],
    root,
    {
      BC1_HTTP_URL,
      BC1_RPC_URL: BC1_WS_URL,
      BC2_WASM_HTTP_URL: process.env.BC2_WASM_HTTP_URL || bc2.contracts.bc2RpcHttp || "http://127.0.0.1:18545",
      BC2_WASM_WS_URL: process.env.BC2_WASM_WS_URL || bc2.contracts.bc2RpcWs || "ws://127.0.0.1:18545",
      BC3_FABRIC_HTTP_URL: process.env.BC3_FABRIC_HTTP_URL || bc3.contracts.bc3FabricHttp || "http://127.0.0.1:18645",
      BC3_FABRIC_GATEWAY_ENDPOINT: process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint || "",
      BC3_FABRIC_CHANNEL: process.env.BC3_FABRIC_CHANNEL || bc3.contracts.bc3FabricChannel || "",
      BC3_FABRIC_CHAINCODE: process.env.BC3_FABRIC_CHAINCODE || bc3.contracts.bc3FabricChaincode || "",
      BC3_FABRIC_MSP_ID: process.env.BC3_FABRIC_MSP_ID || bc3.contracts.bc3FabricMSPID || "",
      BC3_FABRIC_USER_CERT_PATH: process.env.BC3_FABRIC_USER_CERT_PATH || bc3.contracts.bc3FabricUserCertPath || "",
      BC3_FABRIC_USER_KEY_PATH: process.env.BC3_FABRIC_USER_KEY_PATH || bc3.contracts.bc3FabricUserKeyPath || "",
      BC3_FABRIC_TLS_CERT_PATH: process.env.BC3_FABRIC_TLS_CERT_PATH || bc3.contracts.bc3FabricTLSCertPath || "",
      BC3_FABRIC_PEER_NAME: process.env.BC3_FABRIC_PEER_NAME || bc3.contracts.bc3FabricPeerName || "",
    }
  );
}

function rootStateContractsForDepth(bc1Contracts: Record<string, string>, depth: number): string[] {
  const base = [bc1Contracts.sHotel, bc1Contracts.sTrain].filter(Boolean);
  if (base.length < 2) {
    throw new Error("xsmart/bc1 deployment needs sHotel and sTrain root bookkeeping contracts");
  }
  const count = Math.max(2, depth);
  return Array.from({ length: count }, (_, index) => base[index % base.length]);
}

function expectedDestChainsForDepth(depth: number): string[] {
  const chains = ["bc2", "bc3"];
  if (depth >= 3) chains.push("bc2evm");
  if (depth >= 4) chains.push("bc3evm");
  return chains;
}

async function resetTranslatedBenchmarkState(translatedAddress: string, signer: ethers.Signer) {
  const translated = new ethers.Contract(translatedAddress, translatedAbi, signer);
  const metaSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "META"],
  );
  const metaPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "uint256", "uint256"],
    ["benchmark", 100n, 2000n, 1n],
  );
  await (await translated.__vassp_apply(metaSlot, metaPayload)).wait();

  const lockTotalSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "LOCK_TOTAL"],
  );
  const lockTotalPayload = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]);
  await (await translated.__vassp_apply(lockTotalSlot, lockTotalPayload)).wait();
}

function bc2UsesLocalNode(): boolean {
  const bc2 = loadDeployment("xsmart", "bc2");
  const http = (process.env.BC2_WASM_HTTP_URL || bc2.contracts.bc2RpcHttp || "").trim().toLowerCase();
  const ws = (process.env.BC2_WASM_WS_URL || bc2.contracts.bc2RpcWs || "").trim().toLowerCase();
  if (http === "" && ws === "") {
    return true;
  }
  return http.includes("127.0.0.1") || http.includes("localhost") ||
    ws.includes("127.0.0.1") || ws.includes("localhost");
}

function bc3UsesLocalSimulator(): boolean {
	if (process.env.XSMART_FORCE_LOCAL_BC3_SIMULATOR === "1") {
		return true;
	}
	const bc3 = loadDeployment("xsmart", "bc3");
	const gateway = (process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint || "").trim();
  if (gateway) {
    return false;
  }
  const http = (process.env.BC3_FABRIC_HTTP_URL || bc3.contracts.bc3FabricHttp || "").trim().toLowerCase();
	return http === "" || http.includes("127.0.0.1") || http.includes("localhost");
}

function requireProdTopology() {
	const allowLocalBC3Smoke = process.env.XSMART_ALLOW_LOCAL_BC3_PRODUCTION_SMOKE === "1";
	if (bc2UsesLocalNode()) {
		throw new Error(
			"xsmart prod benchmark requires bc2 on VM; set BC2_WASM_HTTP_URL/BC2_WASM_WS_URL to remote endpoints and ensure deployments/xsmart/bc2.json is not localhost",
		);
	}
	if (bc3UsesLocalSimulator() && !allowLocalBC3Smoke) {
		throw new Error(
			"xsmart prod benchmark requires bc3 on VM; set BC3_FABRIC_GATEWAY_ENDPOINT and related Fabric gateway env vars for the remote network, or set XSMART_ALLOW_LOCAL_BC3_PRODUCTION_SMOKE=1 for a non-paper smoke run",
		);
	}
}

async function resetMixedTargets(root: string) {
  if (bc2UsesLocalNode()) {
    stopLocalBC2Node(root);
    await ensureLocalBC2Node(root);
    if (fs.existsSync(BC2_DEPLOY_FILE)) {
      fs.rmSync(BC2_DEPLOY_FILE, { force: true });
    }
    run("npm", ["run", "deploy:xsmart:bc2"], root, {
      XSMART_BC2_DEPLOY_MODE: "local",
      XSMART_BC2_SKIP_NODE_START: "1",
      XSMART_BC2_SKIP_BUILD: process.env.XSMART_BC2_SKIP_BUILD || "1",
    });
  }

  if (bc3UsesLocalSimulator()) {
    stopLocalBC3Fabric(root);
    await ensureLocalBC3Fabric(root);
    if (fs.existsSync(BC3_DEPLOY_FILE)) {
      fs.rmSync(BC3_DEPLOY_FILE, { force: true });
    }
    run("npm", ["run", "deploy:xsmart:bc3"], root);
  }
}

async function prepareFreshTargets(root: string, runIndex: number) {
  const bc2Salt = Buffer.from(`benchmark-${Date.now()}-${runIndex}`, "utf-8").toString("hex");
  if (bc2UsesLocalNode()) {
    stopLocalBC2Node(root);
    await ensureLocalBC2Node(root);
    if (fs.existsSync(BC2_DEPLOY_FILE)) {
      fs.rmSync(BC2_DEPLOY_FILE, { force: true });
    }
    run("npm", ["run", "deploy:xsmart:bc2"], root, {
      XSMART_BC2_DEPLOY_MODE: "local",
      XSMART_BC2_SKIP_NODE_START: "1",
      XSMART_BC2_SKIP_BUILD: process.env.XSMART_BC2_SKIP_BUILD || "1",
      XSMART_BC2_SALT: bc2Salt,
    });
  } else {
    if (fs.existsSync(BC2_DEPLOY_FILE)) {
      fs.rmSync(BC2_DEPLOY_FILE, { force: true });
    }
    run("npm", ["run", "deploy:xsmart:bc2"], root, {
      XSMART_BC2_DEPLOY_MODE: "prod",
      XSMART_BC2_SKIP_BUILD: process.env.XSMART_BC2_SKIP_BUILD || "1",
      XSMART_BC2_SALT: bc2Salt,
    });
  }

  if (bc3UsesLocalSimulator()) {
    stopLocalBC3Fabric(root);
    await ensureLocalBC3Fabric(root);
    if (fs.existsSync(BC3_DEPLOY_FILE)) {
      fs.rmSync(BC3_DEPLOY_FILE, { force: true });
    }
    run("npm", ["run", "deploy:xsmart:bc3"], root);
  }
}

function resetBC3GatewayState(root: string) {
  const bc3 = loadDeployment("xsmart", "bc3");
  const hotelEndpoint = bc3.contracts.hotelBooking || "HotelBooking";
  const bridgeEndpoint = bc3.contracts.xBridgeBc3 || "XBridgeBc3";
  const bridgeMSP = process.env.BC3_FABRIC_BRIDGE_MSP || bc3.contracts.bc3FabricMSPID || "Org1MSP";
  const relayerMSP = process.env.BC3_FABRIC_RELAYER_MSP || bc3.contracts.bc3FabricMSPID || "Org1MSP";

  runRelayer(root, [
    "fabric-submit",
    "--config", RELAYER_CONFIG,
    "--chain", "bc3",
    "--endpoint", hotelEndpoint,
    "--method", "InitLedger",
    "--args", bridgeMSP,
    "--args", String(100),
    "--args", String(2000),
    "--args", String(1),
  ]);
  runRelayer(root, [
    "fabric-submit",
    "--config", RELAYER_CONFIG,
    "--chain", "bc3",
    "--endpoint", bridgeEndpoint,
    "--method", "InitLedger",
    "--args", relayerMSP,
    "--args", hotelEndpoint,
  ]);
}

function loadCheckpointActions(): CheckpointAction[] {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, CheckpointAction>;
    return Object.values(parsed);
  } catch {
    // The relayer checkpoint file is rewritten while the benchmark polls it.
    // A transient partial read should not fail the whole experiment.
    return [];
  }
}

function hasCheckpointAction(
  actions: CheckpointAction[],
  txId: bigint,
  sourceEvent: string,
  destChain: string,
  status: string
): boolean {
  const txIdString = txId.toString();
  return actions.some((action) =>
    action.tx_id === txIdString &&
    action.source_event === sourceEvent &&
    action.dest_chain === destChain &&
    action.status === status
  );
}

function parseMarkersFromRaw(raw: string): RelayerMarker[] {
  const out: RelayerMarker[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as RelayerMarker);
    } catch {
    }
  }
  return out;
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

async function blockTimestamp(provider: ethers.JsonRpcProvider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  return block ? Number(block.timestamp) : 0;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isTimerPhase(value: string | undefined): value is "SUBMIT" | "LOCK_REQ" | "LOCK_ACK" | "EXECUTE" | "UPDATE_REQ" | "UPDATE_ACK" | "ROOT" | "SIGNAL" | "SEGMENT" | "INVOKE_INIT" | "JUDGE_VOTE" | "SETTLE" | "FINAL_CONFIRM" | "ABORT" | "ERROR" {
  switch (value) {
    case "SUBMIT":
    case "LOCK_REQ":
    case "LOCK_ACK":
    case "EXECUTE":
    case "UPDATE_REQ":
    case "UPDATE_ACK":
    case "ROOT":
    case "SIGNAL":
    case "SEGMENT":
    case "INVOKE_INIT":
    case "JUDGE_VOTE":
    case "SETTLE":
    case "FINAL_CONFIRM":
    case "ABORT":
    case "ERROR":
      return true;
    default:
      return false;
  }
}

async function main() {
	const root = repoRoot();
	const runs = Number(getArg("runs", "30"));
	const depth = Number(getArg("depth", "2"));
	const timeoutSeconds = Number(getArg("timeout", "240"));
	const runDelayMs = Number(getArg("run-delay-ms", "3000"));
	const benchmarkStamp = new Date().toISOString().replace(/[:.]/g, "-");
	const jsonlDir = path.join(root, "benchmark-results", `xsmart-prod-${benchmarkStamp}`, "jsonl");

	resetRelayerArtifacts(root);
	requireProdTopology();
	let bc2ProxyName: string | undefined;

  if (USE_BC2_DOCKER_PROXY && !bc2UsesLocalNode()) {
    const bc2Remote = loadDeployment("xsmart", "bc2");
    const remoteWs = (process.env.BC2_WASM_WS_URL || bc2Remote.contracts.bc2RpcWs || "").trim();
    if (!remoteWs) {
      throw new Error("xsmart benchmark requires BC2_WASM_WS_URL or bc2RpcWs deployment value");
    }
    bc2ProxyName = ensureBC2RemoteDockerProxy(root, remoteWs);
  }

  buildRelayer(root);

  const bc1 = loadDeployment("xsmart", "bc1");
  if (!bc1.contracts.xBridgingContract || !bc1.contracts.sHotel || !bc1.contracts.sTrain) {
    throw new Error("xsmart/bc1 deployment is incomplete for benchmark");
  }

  const bc1Request = new ethers.FetchRequest(BC1_HTTP_URL);
  bc1Request.timeout = 60000;
  const provider = new ethers.JsonRpcProvider(
    bc1Request,
    { chainId: 1337, name: "besu-qbft" },
    { staticNetwork: true }
  );
  const wallet = new ethers.Wallet("0x" + PRIVATE_KEYS.relayer, provider);
  const aggregateLogs: string[] = [];
  const wasmSubmitter = startWASMSubmitter(root, loadDeployment("xsmart", "bc2").contracts);

  try {
    await waitFor(
      () => httpHealth(`${wasmSubmitter.url}/health`),
      30000,
      "xsmart wasm submitter",
    );
    const samples: Sample[] = [];
    const bc2Mode = bc2UsesLocalNode() ? "local" : "prod";
    const bc3Mode = bc3UsesLocalSimulator() ? "local" : "prod";
    const skipFreshTargets = process.env.XSMART_SKIP_FRESH_TARGETS === "1";

    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      resetRelayerArtifacts(root);
      if (!skipFreshTargets) {
        await prepareFreshTargets(root, runIndex);
      }
      await renderProdConfig(root, depth);
      if (!bc3UsesLocalSimulator()) {
        resetBC3GatewayState(root);
      }

      const bc2 = loadDeployment("xsmart", "bc2");
      const bc3 = loadDeployment("xsmart", "bc3");
      if (!bc2.contracts.xBridgeBc2) {
        throw new Error("xsmart/bc2 deployment is missing xBridgeBc2 for benchmark");
      }
      if (!bc3.contracts.xBridgeBc3) {
        throw new Error("xsmart/bc3 deployment is missing xBridgeBc3 for benchmark");
      }

      const { child, logs } = startRelayer(root, {
        XSMART_BC2_DEPLOY_MODE: bc2UsesLocalNode() ? "local" : "prod",
        XSMART_WASM_SUBMITTER_URL: wasmSubmitter.url,
      });

      try {
        await sleep(5000);
      const signer = new ethers.NonceManager(wallet);
      const bridge = new ethers.Contract(bc1.contracts.xBridgingContract, bridgeAbi, signer);
      await resetTranslatedBenchmarkState(bc1.contracts.hotelBookingTranslated, signer);
      const txId = BigInt(Date.now()) * 1000n + BigInt(runIndex);
      const timer = new Timer({
        system: "xsmart",
        depth,
        run: runIndex,
        outDir: jsonlDir,
      });
      timer.setTxId(txId.toString());
      timer.stamp("SUBMIT", {
        chain: "bc1",
        event: "requestLockStates",
      });

      const rawSeen = new Set<string>();
      let markerCount = 0;
      let finalBlock = 0;

      const crossChainFee = await withRetry(`[run=${runIndex}] crossChainFee`, () => bridge.crossChainFee());
      const rootStateContracts = rootStateContractsForDepth(bc1.contracts, depth);
      const expectedDestChains = expectedDestChainsForDepth(depth);
      const tx = await withRetry(`[run=${runIndex}] requestLockStates`, () =>
        bridge.requestLockStates(
          txId,
          "travel",
          rootStateContracts,
          30n,
          3n,
          { value: crossChainFee }
        ),
      );
      const receipt = await withRetry(`[run=${runIndex}] wait requestLockStates`, () => tx.wait()) as ethers.TransactionReceipt;
      if (!receipt) {
        throw new Error(`XSmart requestLockStates txId=${txId} returned null receipt`);
      }
      const startBlock = receipt.blockNumber;
      const startTimestamp = await blockTimestamp(provider, startBlock);

      await waitFor(async () => {
        const actions = loadCheckpointActions();
        return expectedDestChains.every((chain) =>
          hasCheckpointAction(actions, txId, "CrossChainLockRequested", chain, "done") &&
          hasCheckpointAction(actions, txId, "CallTreeNodeExecuted", chain, "done")
        );
      }, timeoutSeconds * 1000, `xsmart run=${runIndex} action completion`);

      const deadline = Date.now() + timeoutSeconds * 1000;
      let finalSeen = false;
      while (Date.now() < deadline) {
        const markers = parseMarkersFromRaw(logs.join(""));
        for (const marker of markers) {
          if (marker.protocol !== "xsmart") {
            continue;
          }
          const rawKey = JSON.stringify(marker);
          if (rawSeen.has(rawKey)) {
            continue;
          }
          rawSeen.add(rawKey);
          if (!isTimerPhase(marker.phase) || marker.phase === "SUBMIT") {
            continue;
          }
          markerCount += 1;
          timer.stamp(
            marker.phase,
            {
              chain: marker.chain,
              event: marker.event,
              relayer_ts: marker.ts,
            },
            marker.block
          );
          if (marker.phase === "FINAL_CONFIRM") {
            finalSeen = true;
            finalBlock = Number(marker.block ?? 0);
          }
          if (marker.phase === "ABORT") {
            timer.markError(`xsmart run ${runIndex} aborted at ${marker.chain}:${marker.event}`);
            break;
          }
        }
        if (finalSeen) {
          break;
        }
        await sleep(1000);
      }

      if (!finalSeen || finalBlock === 0) {
        timer.markTimeout();
        const jsonlPath = timer.flush();
        throw new Error(`XSmart txId=${txId} did not reach FINAL_CONFIRM within ${timeoutSeconds}s; last JSONL=${jsonlPath}`);
      }

      const finalTimestamp = await blockTimestamp(provider, finalBlock);
      const summary = timer.summary();
      const jsonlPath = timer.flush();
      const latencyMs = summary.latency_ms ?? 0;

      const sample: Sample = {
        run: runIndex,
        depth,
        txId: txId.toString(),
        startBlock,
        finalBlock,
        latencySeconds: latencyMs / 1000,
        latencyMs,
        blockLatencySeconds: finalTimestamp - startTimestamp,
        markerCount,
        jsonlPath,
      };
      samples.push(sample);
      const outputDir = path.join(root, "benchmark-results");
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, `xsmart-prod-d${depth}.partial.json`),
        JSON.stringify({
          protocol: "xsmart",
          rq: "RQ1c",
          scenario: "heterogeneous-evm-wasm-fabric-depth-scaling",
          depth,
          samples,
          summary: summarize(samples),
        }, null, 2),
        "utf-8",
      );
      console.log(
        `[XSmart][run=${runIndex}] txId=${txId} latency=${sample.latencySeconds.toFixed(3)}s blockLatency=${sample.blockLatencySeconds}s markers=${markerCount}`
      );
      } finally {
        child.kill();
        await sleep(1000);
        aggregateLogs.push(logs.join(""));
      }

      await sleep(runDelayMs);
    }

    const result = {
      protocol: "xsmart",
      rq: "RQ1c",
      scenario: "heterogeneous-evm-wasm-fabric",
      depth,
      mode: bc2Mode === "prod" && bc3Mode === "prod" ? "prod-e2e" : "mixed-e2e",
      proofMode: "production_proof",
      productionProofScope: bc3Mode === "prod" ? "live-endpoint-boundary" : "production-boundary-smoke-with-local-fabric",
      chainModes: {
        bc1: "prod",
        bc2: bc2Mode,
        bc3: bc3Mode,
      },
      runtimeFamilies: {
        bc1: "evm",
        bc2: "wasm",
        bc3: "fabric",
        ...(depth >= 3 ? { bc2evm: "evm" } : {}),
        ...(depth >= 4 ? { bc3evm: "evm" } : {}),
      },
      expectedDestChains: expectedDestChainsForDepth(depth),
      unsupported: {
        integratex: "unsupported for heterogeneous EVM/WASM/Fabric scenario in this prototype",
      },
      jsonlDir,
      summary: summarize(samples),
      samples,
    };

    const outputDir = path.join(root, "benchmark-results");
    fs.mkdirSync(outputDir, { recursive: true });
    const customOutput = getArg("output", "");
    const outputPath = path.join(outputDir, customOutput || `xsmart-prod-d${depth}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
    if (!customOutput) {
      fs.writeFileSync(path.join(outputDir, "xsmart-prod.json"), JSON.stringify(result, null, 2), "utf-8");
    }
    console.log(`Saved benchmark results to ${outputPath}`);
    console.log(result.summary);
  } finally {
    if (bc2ProxyName) {
      stopBC2RemoteDockerProxy(root, bc2ProxyName);
    }
    wasmSubmitter.child.kill();
    aggregateLogs.push(wasmSubmitter.logs.join(""));
    const joinedLogs = aggregateLogs.join("\n");
    const logDir = path.join(root, "configs", "relayer", "var");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(RELAYER_LOG_FILE, joinedLogs, "utf-8");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
