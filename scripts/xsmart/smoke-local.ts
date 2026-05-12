import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { execFileSync, spawn, ChildProcessWithoutNullStreams } from "child_process";
import { ethers } from "ethers";
import {
  PRIVATE_KEYS,
  loadDeployment,
  repoRoot,
} from "../common";
import { ensureLocalBC2Node, stopLocalBC2Node } from "./local-bc2-node";
import { ensureLocalBC3Fabric, LOCAL_BC3_FABRIC_HTTP_URL, stopLocalBC3Fabric } from "./local-bc3-fabric";

const BC1_HTTP_URL = process.env.BC1_HTTP_URL || "http://127.0.0.1:8545";
const BC1_WS_URL = process.env.BC1_RPC_URL || "ws://127.0.0.1:8545";
const BC2_NODE_CONTAINER = process.env.XSMART_BC2_NODE_CONTAINER || "xsmart-bc2-local";
const INK_BUILDER_IMAGE = process.env.XSMART_INK_BUILDER_IMAGE || "xsmart-ink-builder:local";
const SUBSTRATE_SURI = process.env.XSMART_BC2_SURI || "//Alice";
const SUBSTRATE_WS = process.env.XSMART_BC2_DOCKER_WS_URL || "ws://127.0.0.1:9944";
const SUBSTRATE_ALICE = process.env.XSMART_BC2_USER || "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const FABRIC_USER = "fabric-user";
const CHECKPOINT_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-ckpt.json");
const RELAYER_LOG_FILE = path.join(repoRoot(), "configs", "relayer", "var", "xsmart-smoke-relayer.log");

const bridgeAbi = [
  "function crossChainFee() external view returns (uint256)",
  "function requestLockStates(uint256 crossChainTxId, string serviceId, address[] stateContracts, uint256 timeoutBlocks, uint256 destChainId) external payable",
];

const translatedAbi = [
  "function __vassp_apply(bytes32 slot, bytes value) external",
  "function GetAvailableRemain() external view returns (uint256)",
];

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
}

function ensureBc1LocalReachable() {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_chainId",
    params: [],
  });
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      BC1_HTTP_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200 || !raw.includes('"result":"0x539"')) {
            reject(new Error(`bc1 local RPC is not ready at ${BC1_HTTP_URL}`));
            return;
          }
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`bc1 local RPC timeout at ${BC1_HTTP_URL}`));
    });
    req.write(body);
    req.end();
  });
}

async function renderLocalConfig(root: string) {
  run(
    "npx",
    ["ts-node", "--project", "tsconfig.scripts.json", "scripts/xsmart/render-config.ts"],
    root,
    {
      BC1_HTTP_URL,
      BC1_RPC_URL: BC1_WS_URL,
      BC2_WASM_HTTP_URL: "http://127.0.0.1:18545",
      BC2_WASM_WS_URL: "ws://127.0.0.1:18545",
      BC3_FABRIC_HTTP_URL: LOCAL_BC3_FABRIC_HTTP_URL,
      XSMART_BC2_USER: SUBSTRATE_ALICE,
    }
  );
}

function startRelayer(root: string): { child: ChildProcessWithoutNullStreams; logs: string[] } {
  run("go", ["build", "-o", "relayer.exe", "./cmd/relayer"], path.join(root, "relayer"));
  const logs: string[] = [];
  const child = spawn(
    path.join(root, "relayer", "relayer.exe"),
    ["start", "--config", path.join(root, "configs", "relayer", "config-xsmart.yaml")],
    {
      cwd: path.join(root, "relayer"),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function initializeTranslatedState(signer: ethers.Signer, translatedAddress: string) {
  const translated = new ethers.Contract(translatedAddress, translatedAbi, signer);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const metaSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "META"]
  );
  const lockTotalSlot = ethers.solidityPackedKeccak256(
    ["string", "string", "string"],
    ["VASSP", "HotelBooking", "LOCK_TOTAL"]
  );
  const metaValue = coder.encode(["string", "uint256", "uint256", "uint256"], ["xbridge_bc3", 100n, 2000n, 1n]);
  const zeroValue = coder.encode(["uint256"], [0n]);
  await (await translated.__vassp_apply(metaSlot, metaValue)).wait();
  await (await translated.__vassp_apply(lockTotalSlot, zeroValue)).wait();
  const remain = await translated.GetAvailableRemain();
  if (remain !== 2000n) {
    throw new Error(`translated state init failed, expected 2000 got ${remain}`);
  }
}

function dockerInkCallArgs(crateDir: string, artifactName: string, contract: string, message: string, args: string[]) {
  return [
    "run",
    "--rm",
    "--network",
    `container:${BC2_NODE_CONTAINER}`,
    "-v",
    `${crateDir}:/work`,
    "-w",
    "/work",
    INK_BUILDER_IMAGE,
    "cargo",
    "contract",
    "call",
    "--contract",
    contract,
    "--message",
    message,
    "--suri",
    SUBSTRATE_SURI,
    "--url",
    SUBSTRATE_WS,
    "--output-json",
    `/work/${artifactName}`,
    ...(args.length > 0 ? ["--args", ...args] : []),
  ];
}

function decodeInkValue(value: any): any {
  if (!value || typeof value !== "object") return value;
  if ("UInt" in value) return BigInt(value.UInt);
  if ("Literal" in value) return String(value.Literal);
  if ("Hex" in value) return "0x" + String(value.Hex.s);
  if ("Seq" in value) {
    const elems = Array.isArray(value.Seq.elems) ? value.Seq.elems.map(decodeInkValue) : [];
    if (elems.every((item) => typeof item === "bigint" && item >= 0n && item <= 255n)) {
      return Uint8Array.from(elems.map((item) => Number(item)));
    }
    return elems;
  }
  if ("Tuple" in value) {
    const tuple = value.Tuple;
    const ident = tuple.ident;
    const values = Array.isArray(tuple.values) ? tuple.values : [];
    if (ident === "Ok" && values.length === 1) {
      return decodeInkValue(values[0]);
    }
    if (ident === "Err" && values.length === 1) {
      throw new Error(`ink call returned Err: ${JSON.stringify(values[0])}`);
    }
    return values.map(decodeInkValue);
  }
  return value;
}

function queryWasmContract(crateDir: string, artifactName: string, contract: string, message: string, args: string[] = []) {
  const raw = run("docker", dockerInkCallArgs(crateDir, artifactName, contract, message, args), repoRoot());
  const parsed = JSON.parse(raw);
  return decodeInkValue(parsed.data);
}

function getJson(url: string) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request(url, { method: "GET", timeout: 5000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += String(chunk);
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout fetching ${url}`));
    });
    req.end();
  });
}

async function getJsonWithRetry(url: string, attempts = 5, delayMs = 1000) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function resetRelayerArtifacts(root: string) {
  const files = [
    path.join(root, "configs", "relayer", "var", "xsmart-ckpt.json"),
    path.join(root, "configs", "relayer", "var", "xsmart-smoke-relayer.log"),
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }
}

async function redeployLocalEnvironment(root: string) {
  stopLocalBC2Node(root);
  stopLocalBC3Fabric(root);
  await ensureLocalBC2Node(root);
  await ensureLocalBC3Fabric(root);

  const deploymentFiles = [
    path.join(root, "deployments", "xsmart", "local.json"),
    path.join(root, "deployments", "xsmart", "bc1.json"),
    path.join(root, "deployments", "xsmart", "bc2.json"),
    path.join(root, "deployments", "xsmart", "bc3.json"),
  ];
  for (const file of deploymentFiles) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }

  run("npm", ["run", "deploy:xsmart:bc1:local"], root);
  run("npm", ["run", "deploy:xsmart:bc2"], root, {
    XSMART_BC2_SKIP_NODE_START: "1",
    XSMART_BC2_SKIP_BUILD: "1",
  });
  run("npm", ["run", "deploy:xsmart:bc3"], root);
}

type CheckpointAction = {
  tx_id?: string;
  source_event?: string;
  dest_chain?: string;
  status?: string;
};

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

async function main() {
  const root = repoRoot();
  await ensureBc1LocalReachable();
  await ensureLocalBC2Node(root);
  await ensureLocalBC3Fabric(root);
  resetRelayerArtifacts(root);
  await redeployLocalEnvironment(root);
  await renderLocalConfig(root);

  const bc1 = loadDeployment("xsmart", "bc1");
  const bc2 = loadDeployment("xsmart", "bc2");
  const bc3 = loadDeployment("xsmart", "bc3");

  const provider = new ethers.JsonRpcProvider(BC1_HTTP_URL);
  const wallet = new ethers.Wallet("0x" + PRIVATE_KEYS.relayer, provider);
  const signer = new ethers.NonceManager(wallet);
  const bridge = new ethers.Contract(bc1.contracts.xBridgingContract, bridgeAbi, signer);

  await initializeTranslatedState(signer, bc1.contracts.hotelBookingTranslated);

  const trainCrateDir = path.join(root, "contracts", "xsmart", "bc2");
  const trainArtifact = "target/ink/train_booking.contract";
  const beforeBc2Remain = queryWasmContract(
    trainCrateDir,
    trainArtifact,
    bc2.contracts.trainBooking,
    "get_remain"
  ) as bigint;
  const beforeBc2Booking = queryWasmContract(
    trainCrateDir,
    trainArtifact,
    bc2.contracts.trainBooking,
    "get_booking",
    [SUBSTRATE_ALICE]
  ) as bigint;
  const beforeBc2Balance = queryWasmContract(
    trainCrateDir,
    trainArtifact,
    bc2.contracts.trainBooking,
    "get_account_balance",
    [SUBSTRATE_ALICE]
  ) as bigint;
  const beforeBc3State = await getJsonWithRetry(`${LOCAL_BC3_FABRIC_HTTP_URL}/state`);

  const { child, logs } = startRelayer(root);
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
      return hasCheckpointAction(actions, txId, "CallTreeNodeExecuted", "bc2", "done") &&
        hasCheckpointAction(actions, txId, "CallTreeNodeExecuted", "bc3", "done");
    }, 240000, "xsmart local remote updates");

    const afterBc2Remain = queryWasmContract(
      trainCrateDir,
      trainArtifact,
      bc2.contracts.trainBooking,
      "get_remain"
    ) as bigint;
    const afterBc2Booking = queryWasmContract(
      trainCrateDir,
      trainArtifact,
      bc2.contracts.trainBooking,
      "get_booking",
      [SUBSTRATE_ALICE]
    ) as bigint;
    const afterBc2Balance = queryWasmContract(
      trainCrateDir,
      trainArtifact,
      bc2.contracts.trainBooking,
      "get_account_balance",
      [SUBSTRATE_ALICE]
    ) as bigint;
    const afterBc3State = await getJsonWithRetry(`${LOCAL_BC3_FABRIC_HTTP_URL}/state`);

    console.log("XSmart local smoke summary");
    console.log("==========================");
    console.log(`txId=${txId}`);
    console.log(`bc2 remain: ${beforeBc2Remain} -> ${afterBc2Remain}`);
    console.log(`bc2 booking[${SUBSTRATE_ALICE}]: ${beforeBc2Booking} -> ${afterBc2Booking}`);
    console.log(`bc2 balance[${SUBSTRATE_ALICE}]: ${beforeBc2Balance} -> ${afterBc2Balance}`);
    console.log(`bc3 remain: ${beforeBc3State.meta.remain} -> ${afterBc3State.meta.remain}`);
    console.log(`bc3 booking[${FABRIC_USER}]: ${beforeBc3State.bookings?.[FABRIC_USER] || 0} -> ${afterBc3State.bookings?.[FABRIC_USER] || 0}`);
    console.log(`bc3 balance[${FABRIC_USER}]: ${beforeBc3State.accounts?.[FABRIC_USER] || 0} -> ${afterBc3State.accounts?.[FABRIC_USER] || 0}`);
  } finally {
    child.kill();
    await sleep(1000);
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
