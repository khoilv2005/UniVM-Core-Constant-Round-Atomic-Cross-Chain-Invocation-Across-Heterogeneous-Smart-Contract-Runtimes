import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { execFileSync } from "child_process";
import Web3 from "web3";
import { loadDeployment, PRIVATE_KEYS, repoRoot } from "../common";
import { ensureBC2RemoteDockerProxy, stopBC2RemoteDockerProxy } from "./bc2-remote-proxy";

const BC1_HTTP_URL = process.env.BC1_HTTP_URL || "http://209.38.21.129:8545";
const BC1_WS_URL = process.env.BC1_RPC_URL || process.env.BC1_WS_URL || "ws://209.38.21.129:8546";
const RELAYER_CONFIG = path.join(repoRoot(), "configs", "relayer", "config-xsmart.yaml");

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
}

function runInherit(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJSON(url: string, payload: unknown): Promise<any> {
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

async function getJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
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
    req.end();
  });
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function renderConfig(root: string) {
  runInherit(
    "npx",
    ["ts-node", "--project", "tsconfig.scripts.json", "scripts/xsmart/render-config.ts"],
    root,
    {
      BC1_HTTP_URL,
      BC1_RPC_URL: BC1_WS_URL,
      BC2_WASM_HTTP_URL: process.env.BC2_WASM_HTTP_URL || "",
      BC2_WASM_WS_URL: process.env.BC2_WASM_WS_URL || "",
      BC3_FABRIC_HTTP_URL: process.env.BC3_FABRIC_HTTP_URL || "",
      BC3_FABRIC_GATEWAY_ENDPOINT: process.env.BC3_FABRIC_GATEWAY_ENDPOINT || "",
      BC3_FABRIC_CHANNEL: process.env.BC3_FABRIC_CHANNEL || "",
      BC3_FABRIC_CHAINCODE: process.env.BC3_FABRIC_CHAINCODE || "",
      BC3_FABRIC_MSP_ID: process.env.BC3_FABRIC_MSP_ID || "",
      BC3_FABRIC_USER_CERT_PATH: process.env.BC3_FABRIC_USER_CERT_PATH || "",
      BC3_FABRIC_USER_KEY_PATH: process.env.BC3_FABRIC_USER_KEY_PATH || "",
      BC3_FABRIC_TLS_CERT_PATH: process.env.BC3_FABRIC_TLS_CERT_PATH || "",
      BC3_FABRIC_PEER_NAME: process.env.BC3_FABRIC_PEER_NAME || "",
    }
  );
}

async function runRelayerSelfcheck(root: string) {
  runInherit("go", ["build", "-o", "relayer.exe", "./cmd/relayer"], path.join(root, "relayer"));
  runInherit(
    path.join(root, "relayer", "relayer.exe"),
    ["selfcheck", "--config", RELAYER_CONFIG],
    path.join(root, "relayer")
  );
}

async function jsonRpc(url: string, method: string, params: any[] = []) {
  return postJSON(url, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
}

async function probeBC1() {
  const chainIdResp = await jsonRpc(BC1_HTTP_URL, "eth_chainId");
  if (!chainIdResp.result) {
    throw new Error("bc1 eth_chainId returned empty result");
  }

  const web3 = new Web3(new Web3.providers.HttpProvider(BC1_HTTP_URL));
  const account = web3.eth.accounts.privateKeyToAccount("0x" + PRIVATE_KEYS.relayer);
  const nonce = await web3.eth.getTransactionCount(account.address, "pending");
  const gasPrice = await web3.eth.getGasPrice();
  const signed = await account.signTransaction({
    from: account.address,
    to: account.address,
    value: "0x0",
    gas: 21000,
    gasPrice,
    nonce,
    chainId: Number(chainIdResp.result),
  });
  if (!signed.rawTransaction) {
    throw new Error("bc1 probe failed to sign tx");
  }
  const receipt = await new Promise<any>((resolve, reject) => {
    web3.eth.sendSignedTransaction(signed.rawTransaction!)
      .once("receipt", resolve)
      .on("error", reject);
  });
  return {
    chainId: chainIdResp.result,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
  };
}

function cargoRunner(): "docker" | "local" {
  const explicit = (process.env.XSMART_WASM_RUNNER || "").trim().toLowerCase();
  if (explicit === "docker" || explicit === "local") {
    return explicit;
  }
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return "local";
  } catch {
    return "docker";
  }
}

function bc2DeployMode(): "local" | "prod" {
  const explicit = (process.env.XSMART_BC2_DEPLOY_MODE || "").trim().toLowerCase();
  if (explicit === "prod" || explicit === "production" || explicit === "remote") {
    return "prod";
  }
  const bc2 = loadDeployment("xsmart", "bc2");
  return bc2.contracts.bc2DeployMode === "prod" ? "prod" : "local";
}

function bc3DeployMode(): "local" | "prod" {
  const bc3 = loadDeployment("xsmart", "bc3");
  const gatewayEndpoint = (process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint || "").trim();
  return gatewayEndpoint ? "prod" : "local";
}

function requireProdTopology() {
  if (bc2DeployMode() !== "prod") {
    throw new Error(
      "xsmart prod probe requires bc2 on VM; set BC2_WASM_HTTP_URL/BC2_WASM_WS_URL to remote endpoints and ensure bc2 deployment mode is prod",
    );
  }
  if (bc3DeployMode() !== "prod") {
    throw new Error(
      "xsmart prod probe requires bc3 on VM; set BC3_FABRIC_GATEWAY_ENDPOINT and related Fabric gateway env vars for the remote network",
    );
  }
}

function dockerCargoArgs(workdir: string, callArgs: string[]): string[] {
  const out = ["run", "--rm"];
  const dockerNetwork = process.env.XSMART_BC2_DOCKER_NETWORK?.trim();
  if (dockerNetwork) {
    out.push("--network", dockerNetwork);
  } else if (bc2DeployMode() === "local") {
    out.push("--network", `container:${process.env.XSMART_BC2_NODE_CONTAINER || "xsmart-bc2-local"}`);
  }
  out.push("-v", `${workdir}:/work`, "-w", "/work");
  out.push(process.env.XSMART_INK_BUILDER_IMAGE?.trim() || "xsmart-ink-builder:local");
  out.push(...callArgs);
  return out;
}

function bc2CargoWSURL(): string {
  const explicitDocker = process.env.XSMART_BC2_DOCKER_WS_URL?.trim();
  if (explicitDocker) {
    return explicitDocker;
  }
  if (bc2DeployMode() === "local") {
    return "ws://127.0.0.1:9944";
  }
  const remoteHTTP =
    process.env.BC2_WASM_HTTP_URL?.trim() ||
    loadDeployment("xsmart", "bc2").contracts.bc2RpcHttp;
  if (!remoteHTTP) {
    throw new Error("Missing BC2_WASM_HTTP_URL for prod bc2 probe");
  }
  return remoteHTTP;
}

function runCargoContract(crateDir: string, args: string[]): string {
  const runner = cargoRunner();
  if (runner === "local") {
    return run("cargo", args, crateDir);
  }
  return run("docker", dockerCargoArgs(crateDir, ["cargo", ...args]), repoRoot());
}

function parseJsonOutput(raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty cargo-contract output");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
      }
    }
  }
  throw new Error(`unable to parse cargo-contract output:\n${raw}`);
}

function findSS58(value: any): string | null {
  const regex = /5[1-9A-HJ-NP-Za-km-z]{46,47}/;
  const text = JSON.stringify(value);
  const match = text.match(regex);
  return match ? match[0] : null;
}

function findHex64(value: any): string | null {
  const regex = /0x[0-9a-fA-F]{64}/;
  const text = JSON.stringify(value);
  const match = text.match(regex);
  return match ? match[0] : null;
}

async function probeBC2(root: string) {
  const bc2 = loadDeployment("xsmart", "bc2");
  const wsURL = bc2CargoWSURL();
  const httpURL = process.env.BC2_WASM_HTTP_URL || bc2.contracts.bc2RpcHttp;
  if (!wsURL || !httpURL) {
    throw new Error("bc2 deployment missing RPC URLs");
  }
  const systemChain = await jsonRpc(httpURL, "system_chain");
  const bestHeader = await jsonRpc(httpURL, "chain_getHeader");

  const bridgeAddress = bc2.contracts.xBridgeBc2;
  const artifactPath = bc2.contracts.bc2BridgeMetadataPath;
  const submitter = process.env.XSMART_BC2_SURI || bc2.contracts.bc2SubmitterURI || "//Alice";
  if (!bridgeAddress || !artifactPath) {
    throw new Error("bc2 deployment missing bridge address or metadata path");
  }

  const crateDir = path.dirname(artifactPath);
  const artifactName = `/work/${path.basename(artifactPath)}`;
  const relayerOut = runCargoContract(crateDir, [
    "contract",
    "call",
    "--contract",
    bridgeAddress,
    "--message",
    "relayer",
    "--suri",
    submitter,
    "--url",
    wsURL,
    "--output-json",
    artifactName,
  ]);
  const currentRelayer = findSS58(parseJsonOutput(relayerOut)) || process.env.XSMART_BC2_ALICE_ADDRESS || "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  const noopOut = runCargoContract(crateDir, [
    "contract",
    "call",
    "--contract",
    bridgeAddress,
    "--message",
    "set_relayer",
    "--suri",
    submitter,
    "--url",
    wsURL,
    "--skip-confirm",
    "--execute",
    "--output-json",
    artifactName,
    "--args",
    currentRelayer,
  ]);
  const noopParsed = parseJsonOutput(noopOut);
  return {
    chain: systemChain.result,
    bestBlock: bestHeader.result?.number || null,
    txRef: findHex64(noopParsed) || "cargo-contract-executed",
    relayer: currentRelayer,
  };
}

function maybeAppendTLSFlags(args: string[]): string[] {
  const tlsEnabled = (process.env.BC3_FABRIC_TLS_ENABLED || "1").trim() !== "0";
  if (!tlsEnabled) {
    return args;
  }
  return [...args, "--tls", "--cafile", requireEnv("BC3_FABRIC_ORDERER_TLS_CA")];
}

function splitCsvEnv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function probeBC3(root: string) {
  const bc3 = loadDeployment("xsmart", "bc3");
  const simulatorURL = process.env.BC3_FABRIC_HTTP_URL || bc3.contracts.bc3FabricHttp;
  const gatewayEndpoint = process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint;
  const relayerMSP = process.env.BC3_FABRIC_RELAYER_MSP || bc3.contracts.bc3FabricMSPID || "Org1MSP";

  if (!gatewayEndpoint) {
    if (!simulatorURL) {
      throw new Error("bc3 probe requires BC3_FABRIC_GATEWAY_ENDPOINT or BC3_FABRIC_HTTP_URL");
    }
    const health = await getJSON(`${simulatorURL.replace(/\/$/, "")}/health`);
    return {
      mode: "simulator",
      bestBlock: health.block ?? 0,
      txRef: "simulator-health-only",
    };
  }

  const output = run(path.join(root, "relayer", "relayer.exe"), [
    "fabric-submit",
    "--config", RELAYER_CONFIG,
    "--chain", "bc3",
    "--endpoint", bc3.contracts.xBridgeBc3 || "XBridgeBc3",
    "--method", "SetRelayerMSP",
    "--args", relayerMSP,
  ], path.join(root, "relayer"));
  const parsed = JSON.parse(output.trim());
  return {
    mode: "gateway",
    bestBlock: parsed.block_number ?? "gateway-commit-status",
    txRef: parsed.transaction_id || "gateway-submitted",
  };
}

async function ensureBlockProgress(label: string, probe: () => Promise<string | number | null>, timeoutMs: number) {
  const start = await probe();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const current = await probe();
    if (current !== start) {
      return { start, current };
    }
  }
  return { start, current: start };
}

async function main() {
  const root = repoRoot();
  requireProdTopology();
  await renderConfig(root);
  let bc2ProxyName: string | undefined;

  const bc2Remote = loadDeployment("xsmart", "bc2");
  const bc2Ws = (process.env.BC2_WASM_WS_URL || bc2Remote.contracts.bc2RpcWs || "").trim();
  if (bc2DeployMode() === "prod" && bc2Ws) {
    bc2ProxyName = ensureBC2RemoteDockerProxy(root, bc2Ws);
  }
  try {
    console.log("XSmart prod probe");
    console.log("=================");

    console.log("[gate] relayer selfcheck");
    await runRelayerSelfcheck(root);

    console.log("[gate] bc1 connectivity + no-op tx");
    const bc1 = await probeBC1();
    const bc1Progress = await ensureBlockProgress(
      "bc1",
      async () => (await jsonRpc(BC1_HTTP_URL, "eth_blockNumber")).result,
      30000
    );

    console.log("[gate] bc2 connectivity + no-op tx");
    const bc2 = await probeBC2(root);
    const bc2Http = process.env.BC2_WASM_HTTP_URL || loadDeployment("xsmart", "bc2").contracts.bc2RpcHttp;
    const bc2Progress = await ensureBlockProgress(
      "bc2",
      async () => (await jsonRpc(bc2Http, "chain_getHeader")).result?.number || null,
      30000
    );

    console.log("[gate] bc3 connectivity + no-op invoke");
    const bc3 = await probeBC3(root);

    console.log("");
    console.log("Probe summary");
    console.log("-------------");
    console.log(`bc1 chainId=${bc1.chainId} tx=${bc1.txHash} block=${bc1.blockNumber} blockProgress=${String(bc1Progress.start)} -> ${String(bc1Progress.current)}`);
    console.log(`bc2 chain=${bc2.chain} txRef=${bc2.txRef} relayer=${bc2.relayer} blockProgress=${String(bc2Progress.start)} -> ${String(bc2Progress.current)}`);
    console.log(`bc3 mode=${bc3.mode} txRef=${bc3.txRef} block=${String(bc3.bestBlock)}`);
  } finally {
    if (bc2ProxyName) {
      stopBC2RemoteDockerProxy(root, bc2ProxyName);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
