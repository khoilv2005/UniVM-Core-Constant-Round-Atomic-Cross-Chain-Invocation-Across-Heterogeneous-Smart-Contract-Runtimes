import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "child_process";
import { ethers } from "ethers";
import {
  PRIVATE_KEYS,
  loadDeployment,
  repoRoot,
} from "../common";
import { ensureBC2RemoteDockerProxy, stopBC2RemoteDockerProxy } from "./bc2-remote-proxy";
import { ensureLocalBC2Node, stopLocalBC2Node } from "./local-bc2-node";
import { ensureLocalBC3Fabric, stopLocalBC3Fabric } from "./local-bc3-fabric";

const BC1_HTTP_URL = process.env.BC1_HTTP_URL || "http://209.38.21.129:8545";
const BC1_WS_URL = process.env.BC1_RPC_URL || process.env.BC1_WS_URL || "ws://209.38.21.129:8546";
const CHECKPOINT_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-ckpt.json");
const RELAYER_LOG_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-smoke-prod-relayer.log");
const RELAYER_CONFIG = path.join(repoRoot(), "configs", "relayer", "config-xsmart.yaml");
const BC2_DEPLOY_FILE = path.join(repoRoot(), "deployments", "xsmart", "bc2.json");
const BC3_DEPLOY_FILE = path.join(repoRoot(), "deployments", "xsmart", "bc3.json");

const bridgeAbi = [
  "function crossChainFee() external view returns (uint256)",
  "function requestLockStates(uint256 crossChainTxId, string serviceId, address[] stateContracts, uint256 timeoutBlocks, uint256 destChainId) external payable",
];

type CheckpointAction = {
  tx_id?: string;
  source_event?: string;
  dest_chain?: string;
  status?: string;
};

type LogMarker = {
  chain?: string;
  event?: string;
  tx_id?: string;
};

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
}

function buildRelayer(root: string) {
  run("go", ["build", "-o", "relayer.exe", "./cmd/relayer"], path.join(root, "relayer"));
}

function runRelayer(root: string, args: string[]): string {
  return run(
    path.join(root, "relayer", "relayer.exe"),
    args,
    path.join(root, "relayer")
  );
}

function startRelayer(root: string, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcessWithoutNullStreams; logs: string[] } {
  buildRelayer(root);
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
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resetRelayerArtifacts(root: string) {
  const files = [
    path.join(root, "configs", "relayer", "var", "xsmart-ckpt.json"),
    path.join(root, "configs", "relayer", "var", "xsmart-smoke-prod-relayer.log"),
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }
}

async function renderProdConfig(root: string) {
  const bc2 = loadDeployment("xsmart", "bc2");
  const bc3 = loadDeployment("xsmart", "bc3");
  run(
    "npx",
    ["ts-node", "--project", "tsconfig.scripts.json", "scripts/xsmart/render-config.ts"],
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
  const bc3 = loadDeployment("xsmart", "bc3");
  const gateway = (process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint || "").trim();
  if (gateway) {
    return false;
  }
  const http = (process.env.BC3_FABRIC_HTTP_URL || bc3.contracts.bc3FabricHttp || "").trim().toLowerCase();
  return http === "" || http.includes("127.0.0.1") || http.includes("localhost");
}

function requireProdTopology() {
  if (bc2UsesLocalNode()) {
    throw new Error(
      "xsmart prod smoke requires bc2 on VM; set BC2_WASM_HTTP_URL/BC2_WASM_WS_URL to remote endpoints and stop using localhost bc2 deployment values",
    );
  }
  if (bc3UsesLocalSimulator()) {
    throw new Error(
      "xsmart prod smoke requires bc3 on VM; set BC3_FABRIC_GATEWAY_ENDPOINT and related Fabric gateway env vars for the remote network",
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
  const parsed = JSON.parse(raw) as Record<string, CheckpointAction>;
  return Object.values(parsed);
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

function parseLogMarkersFromRaw(raw: string): LogMarker[] {
  const out: LogMarker[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as LogMarker);
    } catch {
    }
  }
  return out;
}

function parseLogMarkers(): LogMarker[] {
  if (!fs.existsSync(RELAYER_LOG_FILE)) {
    return [];
  }
  return parseLogMarkersFromRaw(fs.readFileSync(RELAYER_LOG_FILE, "utf-8"));
}

function hasLogMarker(markers: LogMarker[], txId: bigint, chain: string, event: string): boolean {
  const txIdString = txId.toString();
  return markers.some((marker) =>
    marker.chain === chain &&
    marker.event === event &&
    (marker.tx_id === txIdString || marker.tx_id?.startsWith("0x"))
  );
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const root = repoRoot();
  resetRelayerArtifacts(root);
  requireProdTopology();
  buildRelayer(root);
  await renderProdConfig(root);
  let bc2ProxyName: string | undefined;

  if (!bc2UsesLocalNode()) {
    const bc2Remote = loadDeployment("xsmart", "bc2");
    const remoteWs = (process.env.BC2_WASM_WS_URL || bc2Remote.contracts.bc2RpcWs || "").trim();
    if (!remoteWs) {
      throw new Error("xsmart prod smoke requires BC2_WASM_WS_URL or bc2RpcWs deployment value");
    }
    bc2ProxyName = ensureBC2RemoteDockerProxy(root, remoteWs);
  }
  if (!bc3UsesLocalSimulator()) {
    resetBC3GatewayState(root);
  }

  const bc1 = loadDeployment("xsmart", "bc1");
  const bc2 = loadDeployment("xsmart", "bc2");
  const bc3 = loadDeployment("xsmart", "bc3");
  if (!bc1.contracts.xBridgingContract || !bc1.contracts.sHotel || !bc1.contracts.sTrain) {
    throw new Error("xsmart/bc1 deployment is incomplete for prod smoke");
  }
  if (!bc2.contracts.xBridgeBc2) {
    throw new Error("xsmart/bc2 deployment is missing xBridgeBc2 for prod smoke");
  }
  if (!bc3.contracts.xBridgeBc3) {
    throw new Error("xsmart/bc3 deployment is missing xBridgeBc3 for prod smoke");
  }

  const bc1Request = new ethers.FetchRequest(BC1_HTTP_URL);
  bc1Request.timeout = 60000;
  const provider = new ethers.JsonRpcProvider(
    bc1Request,
    { chainId: 1337, name: "besu-qbft" },
    { staticNetwork: true }
  );
  const wallet = new ethers.Wallet("0x" + PRIVATE_KEYS.relayer, provider);
  const signer = new ethers.NonceManager(wallet);
  const bridge = new ethers.Contract(bc1.contracts.xBridgingContract, bridgeAbi, signer);

  const { child, logs } = startRelayer(root, {
    XSMART_BC2_DEPLOY_MODE: bc2UsesLocalNode() ? "local" : "prod",
  });
  try {
    await sleep(5000);
    const txId = BigInt(Math.floor(Date.now() / 1000));
    const crossChainFee = await bridge.crossChainFee();
    const tx = await bridge.requestLockStates(
      txId,
      "travel",
      [bc1.contracts.sHotel, bc1.contracts.sTrain],
      30n,
      3n,
      { value: crossChainFee }
    );
    await tx.wait();

    await waitFor(async () => {
      const actions = loadCheckpointActions();
      return hasCheckpointAction(actions, txId, "CrossChainLockRequested", "bc2", "done") &&
        hasCheckpointAction(actions, txId, "CrossChainLockRequested", "bc3", "done") &&
        hasCheckpointAction(actions, txId, "CallTreeNodeExecuted", "bc2", "done") &&
        hasCheckpointAction(actions, txId, "CallTreeNodeExecuted", "bc3", "done");
    }, 240000, "xsmart prod remote action completion");

    await sleep(3000);
    const markers = parseLogMarkersFromRaw(logs.join(""));
    const requiredMarkers: Array<{ chain: string; event: string }> = [
      { chain: "bc1", event: "CrossChainLockRequested" },
      { chain: "bc2", event: "CrossChainLockResponse" },
      { chain: "bc3", event: "CrossChainLockResponse" },
      { chain: "bc1", event: "CallTreeNodeExecuted" },
      { chain: "bc1", event: "IntegratedExecutionPerformed" },
      { chain: "bc2", event: "CrossChainUpdateAck" },
      { chain: "bc3", event: "CrossChainUpdateAck" },
    ];
    const missing = requiredMarkers.filter((marker) => !hasLogMarker(markers, txId, marker.chain, marker.event));
    if (missing.length > 0) {
      throw new Error(`Missing prod smoke markers: ${missing.map((m) => `${m.chain}:${m.event}`).join(", ")}`);
    }

    console.log("XSmart prod smoke summary");
    console.log("=========================");
    console.log(`txId=${txId}`);
    for (const marker of requiredMarkers) {
      console.log(`marker ${marker.chain}:${marker.event} ok`);
    }
  } finally {
    child.kill();
    await sleep(1000);
    if (bc2ProxyName) {
      stopBC2RemoteDockerProxy(root, bc2ProxyName);
    }
    const joinedLogs = logs.join("");
    const logDir = path.join(root, "configs", "relayer", "var");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(RELAYER_LOG_FILE, joinedLogs, "utf-8");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
