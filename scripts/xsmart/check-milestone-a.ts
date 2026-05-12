import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadDeployment, relayerConfigDir, repoRoot } from "../common";

type CheckResult = {
  step: string;
  ok: boolean;
  detail: string;
};

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function tryExec(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync(command, args, {
      cwd: repoRoot(),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: process.env,
    });
    return { ok: true, output: String(out).trim() };
  } catch (error: any) {
    const stderr = String(error?.stderr ?? "").trim();
    const stdout = String(error?.stdout ?? "").trim();
    return { ok: false, output: stderr || stdout || String(error?.message ?? error) };
  }
}

function checkA1(): CheckResult {
  const dockerfile = path.join(repoRoot(), "tools", "ubtl", "Dockerfile.test");
  const workflow = path.join(repoRoot(), ".github", "workflows", "ubtl-ir.yml");
  const cargo = tryExec("cargo", ["--version"]);
  const docker = tryExec("docker", ["version", "--format", "{{.Server.Version}}"]);
  const hasRuntime = cargo.ok || docker.ok;
  const detail = [
    `cargo=${cargo.ok ? cargo.output : "unavailable"}`,
    `docker=${docker.ok ? docker.output : docker.output || "daemon unavailable"}`,
    `dockerfile=${exists(dockerfile)}`,
    `workflow=${exists(workflow)}`,
  ].join(" | ");
  return {
    step: "A1 UBTL runtime gate",
    ok: hasRuntime && exists(dockerfile) && exists(workflow),
    detail,
  };
}

function checkA2(): CheckResult {
  const configPath = path.join(relayerConfigDir(), "config-xsmart.yaml");
  const wasmClient = path.join(repoRoot(), "relayer", "internal", "transport", "wasm.go");
  const cfgRaw = exists(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  const hasWasmSection = /\bbc2:\s*[\s\S]*vm:\s*"wasm"/m.test(cfgRaw);
  const metadataMatch = cfgRaw.match(/metadata_path:\s*"([^"]+)"/);
  const endpointMatch = cfgRaw.match(/account_endpoint:\s*"([^"]+)"/);
  const metadataPath = metadataMatch?.[1] ?? "";
  const accountEndpoint = endpointMatch?.[1] ?? "";
  return {
    step: "A2 WASM transport wiring",
    ok:
      exists(wasmClient) &&
      exists(configPath) &&
      hasWasmSection &&
      metadataPath.length > 0 &&
      exists(metadataPath) &&
      accountEndpoint.length > 0,
    detail: [
      `config=${exists(configPath)}`,
      `wasm_client=${exists(wasmClient)}`,
      `bc2_wasm_section=${hasWasmSection}`,
      `metadata=${metadataPath || "missing"}`,
      `metadata_exists=${metadataPath ? exists(metadataPath) : false}`,
      `account_endpoint=${accountEndpoint || "missing"}`,
    ].join(" | "),
  };
}

function checkA3(): CheckResult {
  const bc2Deployment = loadDeployment("xsmart", "bc2");
  const stateArtifact = path.join(
    repoRoot(),
    "contracts",
    "xsmart",
    "bc2",
    "target",
    "ink",
    "train_booking.contract"
  );
  const bridgeArtifact = path.join(
    repoRoot(),
    "contracts",
    "xsmart",
    "bc2",
    "bridge",
    "target",
    "ink",
    "xbridge_bc2.contract"
  );
  return {
    step: "A3 bc2 bridge artifacts/deploy record",
    ok:
      exists(stateArtifact) &&
      exists(bridgeArtifact) &&
      Boolean(bc2Deployment.contracts.trainBooking) &&
      Boolean(bc2Deployment.contracts.xBridgeBc2),
    detail: [
      `state_artifact=${exists(stateArtifact)}`,
      `bridge_artifact=${exists(bridgeArtifact)}`,
      `train_booking=${bc2Deployment.contracts.trainBooking || "missing"}`,
      `xbridge_bc2=${bc2Deployment.contracts.xBridgeBc2 || "missing"}`,
    ].join(" | "),
  };
}

function checkA4(): CheckResult {
  const manifestCandidates = [
    path.join(repoRoot(), "manifests", "xsmart", "travel-hetero.generated.json"),
    path.join(repoRoot(), "manifests", "xsmart", "train-wasm.generated.json"),
  ];
  const manifestPath = manifestCandidates.find((candidate) => exists(candidate)) || manifestCandidates[0];
  const executorFile = path.join(repoRoot(), "relayer", "internal", "protocol", "xsmart", "executor.go");
  const callsFile = path.join(repoRoot(), "relayer", "internal", "protocol", "xsmart", "calls.go");
  const manifestRaw = exists(manifestPath) ? fs.readFileSync(manifestPath, "utf-8") : "";
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
  const hasCallTree = Boolean(manifest?.call_tree_blob);
  const hasWasmTarget = Boolean(manifest?.wasm?.chain && manifest?.wasm?.contract);
  return {
    step: "A4 executor/manifest closure",
    ok: exists(executorFile) && exists(callsFile) && exists(manifestPath) && hasCallTree && hasWasmTarget,
    detail: [
      `executor=${exists(executorFile)}`,
      `calls=${exists(callsFile)}`,
      `manifest=${exists(manifestPath)}`,
      `call_tree_blob=${hasCallTree}`,
      `wasm_target=${hasWasmTarget}`,
    ].join(" | "),
  };
}

function main() {
  const checks = [checkA1(), checkA2(), checkA3(), checkA4()];
  let failed = 0;
  console.log("XSmart Milestone A (A1-A4) gate");
  console.log("================================");
  for (const check of checks) {
    const label = check.ok ? "PASS" : "BLOCKED";
    if (!check.ok) {
      failed++;
    }
    console.log(`[${label}] ${check.step}`);
    console.log(`  ${check.detail}`);
  }
  if (failed > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("All A1-A4 gates are satisfied.");
}

main();
