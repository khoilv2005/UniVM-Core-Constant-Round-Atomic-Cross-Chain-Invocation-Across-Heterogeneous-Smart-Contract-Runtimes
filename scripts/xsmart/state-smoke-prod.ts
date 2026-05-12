import * as http from "http";
import * as path from "path";
import { execFileSync } from "child_process";
import { JsonRpcProvider, Contract } from "ethers";
import { loadDeployment, repoRoot } from "../common";
import { ensureBC2RemoteDockerProxy, stopBC2RemoteDockerProxy } from "./bc2-remote-proxy";

const BC1_HTTP_URL = process.env.BC1_HTTP_URL || "http://209.38.21.129:8545";

const XBRIDGE_ABI = [
  "function relayerManager() external view returns (address)",
  "function ubtlRegistry() external view returns (address)",
];

function run(command: string, args: string[], cwd: string) {
  return execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
    shell: process.platform === "win32",
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
      "xsmart prod state smoke requires bc2 on VM; set BC2_WASM_HTTP_URL/BC2_WASM_WS_URL to remote endpoints and ensure bc2 deployment mode is prod",
    );
  }
  if (bc3DeployMode() !== "prod") {
    throw new Error(
      "xsmart prod state smoke requires bc3 on VM; set BC3_FABRIC_GATEWAY_ENDPOINT and related Fabric gateway env vars for the remote network",
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
    throw new Error("Missing BC2_WASM_HTTP_URL for bc2 state smoke");
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

function findUInt(value: any): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUInt(item);
      if (found != null) return found;
    }
  }
  if (value && typeof value === "object") {
    if ("UInt" in value) {
      const inner = (value as any).UInt;
      if (typeof inner === "number") return inner;
      if (typeof inner === "string" && /^\d+$/.test(inner)) return Number(inner);
    }
    for (const child of Object.values(value)) {
      const found = findUInt(child);
      if (found != null) return found;
    }
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
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

async function readBC1() {
  const bc1 = loadDeployment("xsmart", "bc1");
  const provider = new JsonRpcProvider(BC1_HTTP_URL);
  const bridge = new Contract(bc1.contracts.xBridgingContract, XBRIDGE_ABI, provider);
  const relayerManager = await bridge.relayerManager();
  const ubtlRegistry = await bridge.ubtlRegistry();
  return {
    bridge: bc1.contracts.xBridgingContract,
    relayerManager,
    ubtlRegistry,
  };
}

async function readBC2() {
  const bc2 = loadDeployment("xsmart", "bc2");
  const stateAddress = bc2.contracts.trainBooking;
  const artifactPath = bc2.contracts.bc2MetadataPath;
  const submitter = process.env.XSMART_BC2_SURI || bc2.contracts.bc2SubmitterURI || "//Alice";
  if (!stateAddress || !artifactPath) {
    throw new Error("bc2 deployment missing trainBooking or metadata path");
  }

  const crateDir = path.dirname(artifactPath);
  const artifactName = `/work/${path.basename(artifactPath)}`;
  const out = runCargoContract(crateDir, [
    "contract",
    "call",
    "--contract",
    stateAddress,
    "--message",
    "get_remain",
    "--suri",
    submitter,
    "--url",
    bc2CargoWSURL(),
    "--output-json",
    artifactName,
  ]);
  const parsed = parseJsonOutput(out);
  const remain = findUInt(parsed);
  if (remain == null) {
    throw new Error(`Unable to parse bc2 remain from output: ${JSON.stringify(parsed)}`);
  }
  return {
    trainBooking: stateAddress,
    remain,
  };
}

async function readBC3() {
  const bc3 = loadDeployment("xsmart", "bc3");
  const simulatorURL = process.env.BC3_FABRIC_HTTP_URL || bc3.contracts.bc3FabricHttp;
  const gatewayEndpoint = process.env.BC3_FABRIC_GATEWAY_ENDPOINT || bc3.contracts.bc3FabricGatewayEndpoint;

  if (!gatewayEndpoint) {
    if (!simulatorURL) {
      throw new Error("bc3 state smoke requires BC3_FABRIC_GATEWAY_ENDPOINT or BC3_FABRIC_HTTP_URL");
    }
    const state = await getJSON(`${simulatorURL.replace(/\/$/, "")}/state`);
    return {
      mode: "simulator",
      remain: state?.meta?.remain ?? null,
      endpoint: bc3.contracts.hotelBooking,
    };
  }

  const output = run(path.join(repoRoot(), "relayer", "relayer.exe"), [
    "fabric-evaluate",
    "--config", path.join(repoRoot(), "configs", "relayer", "config-xsmart.yaml"),
    "--chain", "bc3",
    "--endpoint", bc3.contracts.hotelBooking || "HotelBooking",
    "--method", "GetRemain",
  ], path.join(repoRoot(), "relayer")).trim();
  const parsed = JSON.parse(output);
  const remain = Number(parsed.result);
  if (!Number.isFinite(remain)) {
    throw new Error(`Unable to parse bc3 remain from gateway output: ${output}`);
  }
  return {
    mode: "gateway",
    remain,
    endpoint: bc3.contracts.hotelBooking || "HotelBooking",
  };
}

async function main() {
  const root = repoRoot();
  requireProdTopology();
  let bc2ProxyName: string | undefined;
  const bc2 = loadDeployment("xsmart", "bc2");
  const remoteWs = (process.env.BC2_WASM_WS_URL || bc2.contracts.bc2RpcWs || "").trim();
  if (bc2DeployMode() === "prod" && remoteWs) {
    bc2ProxyName = ensureBC2RemoteDockerProxy(root, remoteWs);
  }

  try {
    console.log("XSmart prod state smoke");
    console.log("=======================");

    const bc1State = await readBC1();
    const bc2State = await readBC2();
    const bc3State = await readBC3();

    console.log("bc1");
    console.log(`  bridge=${bc1State.bridge}`);
    console.log(`  relayerManager=${bc1State.relayerManager}`);
    console.log(`  ubtlRegistry=${bc1State.ubtlRegistry}`);

    console.log("bc2");
    console.log(`  trainBooking=${bc2State.trainBooking}`);
    console.log(`  remain=${bc2State.remain}`);

    console.log("bc3");
    console.log(`  mode=${bc3State.mode}`);
    console.log(`  hotelBooking=${bc3State.endpoint}`);
    console.log(`  remain=${bc3State.remain}`);
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
