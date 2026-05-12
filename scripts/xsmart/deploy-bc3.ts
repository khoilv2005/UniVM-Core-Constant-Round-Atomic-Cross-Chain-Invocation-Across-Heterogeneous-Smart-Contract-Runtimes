import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import {
  banner,
  CONSTS,
  ensureDir,
  loadDeployment,
  repoRoot,
  summary,
  writeDeployment,
} from "../common";
import {
  ensureLocalBC3Fabric,
  LOCAL_BC3_FABRIC_HTTP_URL,
} from "./local-bc3-fabric";
import { normalizeEndpointForVM } from "./translation";

type DeployMode = "local" | "peercli";

function postJSON(url: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function runCapture(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
    shell: process.platform === "win32",
  });
}

function runInherit(command: string, args: string[], cwd: string) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function deployMode(): DeployMode {
  const raw = (process.env.XSMART_BC3_DEPLOY_MODE || "").trim().toLowerCase();
  if (raw === "peercli" || raw === "prod" || raw === "production") {
    return "peercli";
  }
  return "local";
}

async function deployLocal(root: string, rec: ReturnType<typeof loadDeployment>) {
  console.log(`  [fabric] ensure local simulator at ${LOCAL_BC3_FABRIC_HTTP_URL}`);
  await ensureLocalBC3Fabric(root);

  console.log("  [bootstrap] xbridge_bc3");
  const response = await postJSON(`${LOCAL_BC3_FABRIC_HTTP_URL}/invoke`, {
    endpoint: "xbridge_bc3",
    message: "bootstrap",
    args: {
      bridge: "xbridge_bc3",
      relayer_id: "xsmart-relayer",
      price: CONSTS.HOTEL_PRICE,
      remain: CONSTS.HOTEL_REMAIN,
      lock_size: CONSTS.LOCK_SIZE,
    },
  });
  if (!response?.ok) {
    throw new Error(`bc3 bootstrap failed: ${response?.error || "unknown error"}`);
  }

  rec.contracts.hotelBooking = "hotel_booking";
  rec.contracts.xBridgeBc3 = "xbridge_bc3";
  rec.contracts.bc3FabricHttp = process.env.BC3_FABRIC_HTTP_URL || LOCAL_BC3_FABRIC_HTTP_URL;
  rec.contracts.bc3ChainId = process.env.BC3_FABRIC_CHAIN_ID || "3";
  rec.contracts.bc3NetworkId = process.env.BC3_FABRIC_NETWORK_ID || "local-simulator";
}

function peerBinary(): string {
  return process.env.BC3_FABRIC_PEER_BIN?.trim() || "peer";
}

function chaincodePackagePath(root: string): string {
  return path.join(root, "artifacts", "xsmart", "fabric", "xsmart-bc3.tar.gz");
}

function splitCsvEnv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function packageChaincode(root: string, packagePath: string, label: string, chaincodeDir: string) {
  ensureDir(path.dirname(packagePath));
  runInherit(peerBinary(), [
    "lifecycle", "chaincode", "package", packagePath,
    "--path", chaincodeDir,
    "--lang", "golang",
    "--label", label,
  ], root);
}

function installChaincode(root: string, packagePath: string) {
  runInherit(peerBinary(), ["lifecycle", "chaincode", "install", packagePath], root);
}

function queryInstalled(root: string): string {
  return runCapture(peerBinary(), ["lifecycle", "chaincode", "queryinstalled"], root);
}

function packageIDForLabel(queryInstalledOutput: string, label: string): string {
  const lines = queryInstalledOutput.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/Package ID:\s*([^,]+),\s*Label:\s*(.+)\s*$/);
    if (match && match[2].trim() === label) {
      return match[1].trim();
    }
  }
  throw new Error(`Unable to locate package ID for label ${label}`);
}

function maybeAppendTLSFlags(args: string[]): string[] {
  const tlsEnabled = (process.env.BC3_FABRIC_TLS_ENABLED || "1").trim() !== "0";
  if (!tlsEnabled) {
    return args;
  }
  const cafile = requiredEnv("BC3_FABRIC_ORDERER_TLS_CA");
  return [...args, "--tls", "--cafile", cafile];
}

function approveForMyOrg(root: string, packageID: string, chaincodeName: string, version: string, sequence: string, channel: string) {
  const orderer = requiredEnv("BC3_FABRIC_ORDERER_ENDPOINT");
  const baseArgs = [
    "lifecycle", "chaincode", "approveformyorg",
    "-o", orderer,
    "--channelID", channel,
    "--name", chaincodeName,
    "--version", version,
    "--package-id", packageID,
    "--sequence", sequence,
  ];
  runInherit(peerBinary(), maybeAppendTLSFlags(baseArgs), root);
}

function commitChaincode(root: string, chaincodeName: string, version: string, sequence: string, channel: string) {
  const orderer = requiredEnv("BC3_FABRIC_ORDERER_ENDPOINT");
  const peerAddresses = splitCsvEnv("BC3_FABRIC_PEER_ADDRESSES");
  const tlsRoots = splitCsvEnv("BC3_FABRIC_TLS_ROOT_CERT_FILES");
  if (peerAddresses.length === 0) {
    throw new Error("BC3_FABRIC_PEER_ADDRESSES is required");
  }
  if (tlsRoots.length > 0 && tlsRoots.length !== peerAddresses.length) {
    throw new Error("BC3_FABRIC_TLS_ROOT_CERT_FILES must match BC3_FABRIC_PEER_ADDRESSES count");
  }

  const baseArgs = [
    "lifecycle", "chaincode", "commit",
    "-o", orderer,
    "--channelID", channel,
    "--name", chaincodeName,
    "--version", version,
    "--sequence", sequence,
  ];
  for (let i = 0; i < peerAddresses.length; i++) {
    baseArgs.push("--peerAddresses", peerAddresses[i]);
    if (tlsRoots[i]) {
      baseArgs.push("--tlsRootCertFiles", tlsRoots[i]);
    }
  }
  runInherit(peerBinary(), maybeAppendTLSFlags(baseArgs), root);
}

function invokeChaincode(root: string, chaincodeName: string, channel: string, fn: string, args: string[]) {
  const orderer = requiredEnv("BC3_FABRIC_ORDERER_ENDPOINT");
  const peerAddresses = splitCsvEnv("BC3_FABRIC_PEER_ADDRESSES");
  const tlsRoots = splitCsvEnv("BC3_FABRIC_TLS_ROOT_CERT_FILES");
  if (peerAddresses.length === 0) {
    throw new Error("BC3_FABRIC_PEER_ADDRESSES is required");
  }

  const payload = JSON.stringify({
    function: fn,
    Args: args,
  });
  const baseArgs = [
    "chaincode", "invoke",
    "-o", orderer,
    "-C", channel,
    "-n", chaincodeName,
    "-c", payload,
    "--waitForEvent",
  ];
  for (let i = 0; i < peerAddresses.length; i++) {
    baseArgs.push("--peerAddresses", peerAddresses[i]);
    if (tlsRoots[i]) {
      baseArgs.push("--tlsRootCertFiles", tlsRoots[i]);
    }
  }
  runInherit(peerBinary(), maybeAppendTLSFlags(baseArgs), root);
}

async function deployPeerCLI(root: string, rec: ReturnType<typeof loadDeployment>) {
  const chaincodeName = process.env.BC3_FABRIC_CHAINCODE_NAME?.trim() || "xsmart-bc3";
  const label = process.env.BC3_FABRIC_CHAINCODE_LABEL?.trim() || `${chaincodeName}_1`;
  const version = process.env.BC3_FABRIC_CHAINCODE_VERSION?.trim() || "1.0";
  const sequence = process.env.BC3_FABRIC_CHAINCODE_SEQUENCE?.trim() || "1";
  const channel = process.env.BC3_FABRIC_CHANNEL?.trim() || "mychannel";
  const relayerMSP = process.env.BC3_FABRIC_RELAYER_MSP?.trim() || "Org1MSP";
  const bridgeMSP = process.env.BC3_FABRIC_BRIDGE_MSP?.trim() || relayerMSP;
  const stateContract = normalizeEndpointForVM("fabric", process.env.XSMART_BC3_STATE_CONTRACT || "HotelBooking");
  const bridgeContract = normalizeEndpointForVM("fabric", process.env.XSMART_BC3_ACCOUNT_ENDPOINT || "XBridgeBc3");
  const chaincodeDir = path.join(root, "contracts", "xsmart", "bc3");
  const packagePath = process.env.BC3_FABRIC_PACKAGE_PATH?.trim() || chaincodePackagePath(root);

  console.log(`  [fabric] peer lifecycle deploy -> ${chaincodeName}`);
  console.log(`           channel=${channel} label=${label} version=${version} sequence=${sequence}`);

  if (process.env.XSMART_BC3_SKIP_PACKAGE !== "1") {
    console.log(`  [package] ${packagePath}`);
    packageChaincode(root, packagePath, label, chaincodeDir);
  }

  if (process.env.XSMART_BC3_SKIP_INSTALL !== "1") {
    console.log("  [install] chaincode package");
    installChaincode(root, packagePath);
  }

  const packageID = process.env.BC3_FABRIC_PACKAGE_ID?.trim() || packageIDForLabel(queryInstalled(root), label);
  console.log(`  [package-id] ${packageID}`);

  if (process.env.XSMART_BC3_SKIP_APPROVE !== "1") {
    console.log("  [approve] lifecycle approveformyorg");
    approveForMyOrg(root, packageID, chaincodeName, version, sequence, channel);
  }

  if (process.env.XSMART_BC3_SKIP_COMMIT !== "1") {
    console.log("  [commit] lifecycle commit");
    commitChaincode(root, chaincodeName, version, sequence, channel);
  }

  if (process.env.XSMART_BC3_SKIP_BOOTSTRAP !== "1") {
    console.log("  [init] HotelBooking:InitLedger");
    invokeChaincode(root, chaincodeName, channel, "HotelBooking:InitLedger", [
      bridgeMSP,
      String(CONSTS.HOTEL_PRICE),
      String(CONSTS.HOTEL_REMAIN),
      String(CONSTS.LOCK_SIZE),
    ]);
    console.log("  [init] XBridgeBc3:InitLedger");
    invokeChaincode(root, chaincodeName, channel, "XBridgeBc3:InitLedger", [
      relayerMSP,
      stateContract,
    ]);
  }

  rec.contracts.hotelBooking = normalizeEndpointForVM("fabric", stateContract);
  rec.contracts.xBridgeBc3 = normalizeEndpointForVM("fabric", bridgeContract);
  rec.contracts.bc3FabricChaincode = chaincodeName;
  rec.contracts.bc3FabricChannel = channel;
  rec.contracts.bc3FabricGatewayEndpoint = process.env.BC3_FABRIC_GATEWAY_ENDPOINT || "";
  rec.contracts.bc3FabricMSPID = relayerMSP;
  rec.contracts.bc3FabricPeerName = process.env.BC3_FABRIC_PEER_NAME || "";
  rec.contracts.bc3ChainId = process.env.BC3_FABRIC_CHAIN_ID || "3";
  rec.contracts.bc3NetworkId = process.env.BC3_FABRIC_NETWORK_ID || channel;
}

async function main() {
  const net = "bc3";
  banner("xsmart", net);
  const rec = loadDeployment("xsmart", net);

  const root = repoRoot();
  if (deployMode() === "peercli") {
    await deployPeerCLI(root, rec);
  } else {
    await deployLocal(root, rec);
  }

  ensureDir(path.dirname(path.join(root, "deployments", "xsmart", `${net}.json`)));
  writeDeployment(rec);
  summary(rec);

  const sourcePath = path.join(root, "contracts", "xsmart", "bc3", "xbridge_bc3.go");
  if (fs.existsSync(sourcePath)) {
    console.log(`  [source] ${sourcePath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
