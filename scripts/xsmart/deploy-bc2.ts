import * as fs from "fs";
import * as path from "path";
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
  ensureLocalBC2Node,
  LOCAL_BC2_HTTP_URL,
  LOCAL_BC2_NODE_CONTAINER,
  LOCAL_BC2_WS_URL,
} from "./local-bc2-node";
import {
  ensureBC2RemoteDockerProxy,
  stopBC2RemoteDockerProxy,
} from "./bc2-remote-proxy";
import { normalizeEndpointForVM } from "./translation";

type DeployMode = "local" | "prod";

const VM2_NETWORK_ENV = path.join(
  repoRoot(),
  "configs",
  "vm2-network.env"
);
const DEFAULT_PROD_BC2_HTTP_URL = "http://170.64.194.4:18545";
const DEFAULT_PROD_BC2_WS_URL = "ws://170.64.194.4:18545";

function runOrThrow(command: string, args: string[], cwd: string) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function runCapture(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
  });
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["--version"], {
      cwd: repoRoot(),
      stdio: "ignore",
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

function readVm2Env(name: string): string | null {
  if (!fs.existsSync(VM2_NETWORK_ENV)) {
    return null;
  }
  const raw = fs.readFileSync(VM2_NETWORK_ENV, "utf-8");
  const match = raw.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function defaultProdBC2HTTPURL(): string {
  return readVm2Env("WASM_RPC_URL") || DEFAULT_PROD_BC2_HTTP_URL;
}

function defaultProdBC2WSURL(): string {
  const fromHttp = defaultProdBC2HTTPURL().replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
  return process.env.BC2_WASM_WS_URL?.trim() || fromHttp || DEFAULT_PROD_BC2_WS_URL;
}

function deployMode(): DeployMode {
  const raw = (process.env.XSMART_BC2_DEPLOY_MODE || "").trim().toLowerCase();
  if (raw === "prod" || raw === "production" || raw === "remote") {
    return "prod";
  }
  return "local";
}

function buildWithDocker(root: string, crateDir: string) {
  const dockerfile = path.join(root, "docker", "xsmart-ink-builder.Dockerfile");
  runOrThrow(
    "docker",
    ["build", "-t", "xsmart-ink-builder:local", "-f", dockerfile, root],
    root
  );
  runOrThrow(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${crateDir}:/work`,
      "-w",
      "/work",
      "xsmart-ink-builder:local",
      "cargo",
      "contract",
      "build",
      "--release",
    ],
    crateDir
  );
}

function dockerCargoContract(root: string, crateDir: string, args: string[], mode: DeployMode): string {
  const dockerArgs = ["run", "--rm"];
  const dockerNetwork = process.env.XSMART_BC2_DOCKER_NETWORK?.trim();
  if (dockerNetwork) {
    dockerArgs.push("--network", dockerNetwork);
  } else if (mode === "local") {
    dockerArgs.push("--network", `container:${LOCAL_BC2_NODE_CONTAINER}`);
  }
  return runCapture(
    "docker",
    [
      ...dockerArgs,
      "-v",
      `${crateDir}:/work`,
      "-w",
      "/work",
      process.env.XSMART_INK_BUILDER_IMAGE?.trim() || "xsmart-ink-builder:local",
      ...args,
    ],
    root
  );
}

function bc2WSURL(mode: DeployMode): string {
  const explicitDocker = process.env.XSMART_BC2_DOCKER_WS_URL?.trim();
  if (explicitDocker) {
    return explicitDocker;
  }
  if (mode === "local") {
    return LOCAL_BC2_WS_URL.replace(":18545", ":9944");
  }
  const remoteWS = process.env.BC2_WASM_WS_URL?.trim();
  if (remoteWS) {
    return remoteWS;
  }
  return defaultProdBC2WSURL();
}

function bc2HTTPURL(mode: DeployMode): string {
  if (mode === "local") {
    return process.env.BC2_WASM_HTTP_URL || LOCAL_BC2_HTTP_URL;
  }
  const remoteHTTP = process.env.BC2_WASM_HTTP_URL?.trim();
  if (remoteHTTP) {
    return remoteHTTP;
  }
  return defaultProdBC2HTTPURL();
}

function bc2ChainID(): string {
  return (process.env.BC2_WASM_CHAIN_ID || "1338").trim();
}

function bc2NetworkID(): string {
  return (process.env.BC2_WASM_NETWORK_ID || `substrate-${bc2ChainID()}`).trim();
}

function toContainerPath(crateDir: string, hostPath: string): string {
  return `/work/${path.relative(crateDir, hostPath).split(path.sep).join("/")}`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function parseJsonOutput(raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("cargo-contract returned empty output");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {
      }
    }
  }
  throw new Error(`Unable to parse cargo-contract JSON output:\n${raw}`);
}

function extractContractAddress(payload: any): string {
  const candidates = [
    payload?.contract,
    payload?.accountId,
    payload?.contractAddress,
    payload?.result?.contract,
    payload?.result?.accountId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const raw = JSON.stringify(payload);
  const match = raw.match(/5[1-9A-HJ-NP-Za-km-z]{46,47}/);
  if (match) {
    return match[0];
  }
  throw new Error(`Unable to locate contract address in output: ${raw}`);
}

function instantiateContract(
  root: string,
  crateDir: string,
  artifactPath: string,
  args: string[],
  mode: DeployMode
): string {
  const wsURL = bc2WSURL(mode);
  const suri = process.env.XSMART_BC2_SURI || "//Alice";
  const salt = process.env.XSMART_BC2_SALT?.trim();
  const instantiateArgs = [
    "cargo",
    "contract",
    "instantiate",
    "--suri",
    suri,
    "--url",
    wsURL,
    "--skip-confirm",
    "--execute",
    "--output-json",
    "--constructor",
    "new",
    toContainerPath(crateDir, artifactPath),
    "--args",
    ...args,
  ];
  if (salt) {
    instantiateArgs.push("--salt", salt);
  }
  const out = dockerCargoContract(root, crateDir, [
    ...instantiateArgs,
  ], mode);
  return extractContractAddress(parseJsonOutput(out));
}

function callContract(
  root: string,
  crateDir: string,
  artifactPath: string,
  contractAddress: string,
  message: string,
  args: string[],
  mode: DeployMode
) {
  const wsURL = bc2WSURL(mode);
  const suri = process.env.XSMART_BC2_SURI || "//Alice";
  dockerCargoContract(root, crateDir, [
    "cargo",
    "contract",
    "call",
    "--contract",
    contractAddress,
    "--message",
    message,
    "--suri",
    suri,
    "--url",
    wsURL,
    "--skip-confirm",
    "--execute",
    "--output-json",
    toContainerPath(crateDir, artifactPath),
    "--args",
    ...args,
  ], mode);
}

async function main() {
  const net = "bc2";
  const mode = deployMode();
  banner("xsmart", `${net}-${mode}`);
  const rec = loadDeployment("xsmart", net);

  const root = repoRoot();
  const stateCrateDir = path.join(root, "contracts", "xsmart", "bc2");
  const bridgeCrateDir = path.join(root, "contracts", "xsmart", "bc2", "bridge");
  const stateArtifact = path.join(
    stateCrateDir,
    "target",
    "ink",
    "train_booking.contract"
  );
  const bridgeArtifact = path.join(
    bridgeCrateDir,
    "target",
    "ink",
    "xbridge_bc2.contract"
  );

  if (process.env.XSMART_BC2_SKIP_BUILD !== "1") {
    const useDocker =
      process.env.XSMART_BC2_BUILD_WITH_DOCKER === "1" || !hasCommand("cargo");
    if (useDocker) {
      console.log("  [build] train_booking (ink! via docker)");
      buildWithDocker(root, stateCrateDir);
      console.log("  [build] xbridge_bc2 (ink! via docker)");
      buildWithDocker(root, bridgeCrateDir);
    } else {
      console.log("  [build] train_booking (ink!)");
      runOrThrow("cargo", ["contract", "build", "--release"], stateCrateDir);
      console.log("  [build] xbridge_bc2 (ink!)");
      runOrThrow("cargo", ["contract", "build", "--release"], bridgeCrateDir);
    }
  }

  if (!fs.existsSync(stateArtifact)) {
    throw new Error(`Missing state artifact: ${stateArtifact}`);
  }
  if (!fs.existsSync(bridgeArtifact)) {
    throw new Error(`Missing bridge artifact: ${bridgeArtifact}`);
  }

  if ((rec.contracts.bc2DeployMode || "") !== mode) {
    delete rec.contracts.trainBooking;
    delete rec.contracts.xBridgeBc2;
  }

  let remoteProxyName: string | undefined;
  if (mode === "prod" && !process.env.XSMART_BC2_DOCKER_WS_URL?.trim()) {
    remoteProxyName = ensureBC2RemoteDockerProxy(root, bc2WSURL(mode));
  }

  console.log(`  [artifact] ${stateArtifact}`);
  console.log(`  [artifact] ${bridgeArtifact}`);

  try {
    let stateAddress =
      process.env.XSMART_BC2_STATE_CONTRACT?.trim() ||
      rec.contracts.trainBooking ||
      "";
    let bridgeAddress =
      process.env.XSMART_BC2_BRIDGE_CONTRACT?.trim() ||
      rec.contracts.xBridgeBc2 ||
      "";

    if (process.env.FORCE_REDEPLOY === "1") {
      console.log("  [force] FORCE_REDEPLOY=1, instantiating fresh bc2 WASM contracts");
      stateAddress = "";
      bridgeAddress = "";
    }

    if (process.env.XSMART_BC2_SKIP_INSTANTIATE !== "1") {
      if (mode === "local" && process.env.XSMART_BC2_SKIP_NODE_START !== "1") {
        console.log(`  [node]  ensure local substrate node at ${LOCAL_BC2_HTTP_URL}`);
        await ensureLocalBC2Node(root);
      }

      const aliceAddress =
        process.env.XSMART_BC2_ALICE_ADDRESS ||
        "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
      const irHash = process.env.XSMART_BC2_IR_HASH || "0x" + "07".repeat(32);

      if (!stateAddress) {
        console.log("  [instantiate] train_booking");
        stateAddress = instantiateContract(root, stateCrateDir, stateArtifact, [
          aliceAddress,
          String(CONSTS.TRAIN_PRICE),
          String(CONSTS.TRAIN_SEATS),
          String(CONSTS.LOCK_SIZE),
          irHash,
        ], mode);
        console.log(`               -> ${stateAddress}`);
      } else {
        console.log(`  [skip] train_booking already at ${stateAddress}`);
      }

      if (!bridgeAddress) {
        console.log("  [instantiate] xbridge_bc2");
        bridgeAddress = instantiateContract(root, bridgeCrateDir, bridgeArtifact, [
          aliceAddress,
          stateAddress,
        ], mode);
        console.log(`               -> ${bridgeAddress}`);
      } else {
        console.log(`  [skip] xbridge_bc2 already at ${bridgeAddress}`);
      }

      console.log("  [init]  train_booking.set_bridge(xbridge_bc2)");
      callContract(
        root,
        stateCrateDir,
        stateArtifact,
        stateAddress,
        "set_bridge",
        [bridgeAddress],
        mode
      );
    }

    if (!stateAddress) {
      stateAddress = requireEnv("XSMART_BC2_STATE_CONTRACT");
    }
    if (!bridgeAddress) {
      bridgeAddress = requireEnv("XSMART_BC2_BRIDGE_CONTRACT");
    }

    rec.contracts.trainBooking = normalizeEndpointForVM("wasm", stateAddress);
    rec.contracts.xBridgeBc2 = normalizeEndpointForVM("wasm", bridgeAddress);
    rec.contracts.bc2RpcHttp = bc2HTTPURL(mode);
    rec.contracts.bc2RpcWs = mode === "local"
      ? (process.env.BC2_WASM_WS_URL || LOCAL_BC2_WS_URL)
      : (process.env.BC2_WASM_WS_URL?.trim() || defaultProdBC2WSURL());
    rec.contracts.bc2ChainId = bc2ChainID();
    rec.contracts.bc2NetworkId = bc2NetworkID();
    rec.contracts.bc2MetadataPath = stateArtifact.split(path.sep).join("/");
    rec.contracts.bc2BridgeMetadataPath = bridgeArtifact.split(path.sep).join("/");
    rec.contracts.bc2SubmitterURI = process.env.XSMART_BC2_SURI || "//Alice";
    rec.contracts.bc2DeployMode = mode;

    ensureDir(path.dirname(path.join(root, "deployments", "xsmart", `${net}.json`)));
    writeDeployment(rec);
    summary(rec);
  } finally {
    if (remoteProxyName) {
      stopBC2RemoteDockerProxy(root, remoteProxyName);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
