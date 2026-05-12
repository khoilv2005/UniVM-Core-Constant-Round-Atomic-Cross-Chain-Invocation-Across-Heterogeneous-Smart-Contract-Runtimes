import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";

type FailureCase = "kill-lock" | "kill-after-commit";

type ExecutionState = {
  active: boolean;
  phase: number;
  updateAckCount: bigint;
};

type FailureResult = {
  caseId: string;
  runs: number;
  faultPoint: string;
  finalPhase: string;
  stateConsistent: boolean;
  locksReleasedOrRetryable: string;
  recoveryTimeMs: number | null;
  status: "pass" | "fail";
  txId: string;
  notes: string;
};

const ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "benchmark-results", "failure-injection");
const PHASES = ["None", "Requested", "CommitDecided", "AbortDecided", "Completed", "RolledBack"];
const BENCHMARK_USER_PRIVATE_KEY = "0x70ff25649b86772b672f211d338ea82f042683c2bf5901a9a1e542f77110489e";

function getArg(name: string, defaultValue: string): string {
  const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
  if (envValue && envValue.trim() !== "") return envValue;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return defaultValue;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDeployment(name: string) {
  const filePath = path.join(ROOT, "deployments", "xsmart", `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as { contracts: Record<string, string> };
}

function selectedStateContracts(deploymentBc2: ReturnType<typeof loadDeployment>, deploymentBc3: ReturnType<typeof loadDeployment>) {
  return [deploymentBc2.contracts.sHotel, deploymentBc3.contracts.sTrain];
}

function relayerBinaryPath() {
  return path.join(ROOT, "relayer", process.platform === "win32" ? "relayer.exe" : "relayer");
}

function relayerConfigPath() {
  return path.join(ROOT, "configs", "relayer", "config-xsmart-1a.yaml");
}

function clearRelayerCheckpoint() {
  const file = path.join(ROOT, "configs", "relayer", "var", "xsmart-ckpt.json");
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

function startRelayer(label: string): ChildProcess {
  const exe = relayerBinaryPath();
  const config = relayerConfigPath();
  if (!fs.existsSync(exe)) throw new Error(`Missing relayer binary: ${exe}`);
  if (!fs.existsSync(config)) throw new Error(`Missing relayer config: ${config}`);

  const logDir = path.join(OUT_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${label}.out.log`), "a");
  const err = fs.openSync(path.join(logDir, `${label}.err.log`), "a");
  return spawn(exe, ["start", "--config", config], {
    cwd: ROOT,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: {
      ...process.env,
      XSMART_RELAYER_FORCE_POLL_LOGS: "1",
      XSMART_RELAYER_EVM_LOG_LOOKBACK_BLOCKS: "24",
    },
  });
}

async function stopRelayer(child: ChildProcess | null) {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await sleep(1500);
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
}

async function executionState(bridgeAddress: string, txId: bigint): Promise<ExecutionState> {
  const reader = await ethers.getContractAt(
    [
      "function activeExecutions(uint256) view returns (address initiator, uint256 startBlock, uint256 timeoutBlocks, uint256 updateAckCount, bool active, uint8 phase)",
    ],
    bridgeAddress,
  );
  const exec = await reader.activeExecutions(txId);
  return {
    active: exec.active,
    phase: Number(exec.phase),
    updateAckCount: exec.updateAckCount,
  };
}

async function waitForPhase(bridgeAddress: string, txId: bigint, phase: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exec = await executionState(bridgeAddress, txId);
    if (exec.phase === phase) return true;
    await sleep(500);
  }
  return false;
}

async function waitForInactive(bridgeAddress: string, txId: bigint, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exec = await executionState(bridgeAddress, txId);
    if (!exec.active) return true;
    await sleep(500);
  }
  return false;
}

async function advanceBlocks(count: number) {
  const startBlock = await ethers.provider.getBlockNumber();
  try {
    await ethers.provider.send("hardhat_mine", [`0x${count.toString(16)}`]);
    return;
  } catch {
    // Besu/VM does not support hardhat_mine. Wait for real blocks.
  }

  const targetBlock = startBlock + count;
  while ((await ethers.provider.getBlockNumber()) < targetBlock) {
    await sleep(1500);
  }
}

async function submitRequest(bridge: any, stateContracts: string[], txId: bigint) {
  const user = new ethers.Wallet(BENCHMARK_USER_PRIVATE_KEY, ethers.provider);
  const fee = await bridge.crossChainFee();
  const tx = await bridge.connect(user).requestLockStates(txId, "travel", stateContracts, 3n, 2n, { value: fee });
  return tx.wait();
}

async function ensureBenchmarkUserFunded() {
  const user = new ethers.Wallet(BENCHMARK_USER_PRIVATE_KEY, ethers.provider);
  const balance = await ethers.provider.getBalance(user.address);
  if (balance >= ethers.parseEther("1")) return;

  const [funder] = await ethers.getSigners();
  const tx = await funder.sendTransaction({
    to: user.address,
    value: ethers.parseEther("2"),
  });
  await tx.wait();
}

async function runKillLock(): Promise<FailureResult> {
  const deploymentBc1 = loadDeployment("bc1-1a");
  const deploymentBc2 = loadDeployment("bc2-evm");
  const deploymentBc3 = loadDeployment("bc3-evm");
  const bridge = await ethers.getContractAt("XBridgingContract", deploymentBc1.contracts.xBridgingContract);
  const bridgeAddress = await bridge.getAddress();
  const stateContracts = selectedStateContracts(deploymentBc2, deploymentBc3);
  const txId = BigInt(Date.now()) * 1000n + 1001n;

  await ensureBenchmarkUserFunded();
  let relayer: ChildProcess | null = startRelayer("fi1-kill-lock-before");
  await sleep(5000);
  await submitRequest(bridge, stateContracts, txId);

  const killedAtMs = Date.now();
  await stopRelayer(relayer);
  relayer = null;

  await advanceBlocks(5);
  let timeoutTriggered = false;
  try {
    const tx = await bridge.timeoutExecution(txId);
    await tx.wait();
    timeoutTriggered = true;
  } catch (error) {
    // If the relayer already progressed to commit before the kill, FI-1 did not
    // inject early enough. Record a fail instead of hiding it.
    const exec = await executionState(bridgeAddress, txId);
    return {
      caseId: "FI-1",
      runs: 1,
      faultPoint: "relayer killed during lock phase",
      finalPhase: PHASES[exec.phase],
      stateConsistent: false,
      locksReleasedOrRetryable: exec.active ? "not proven" : "not active",
      recoveryTimeMs: null,
      status: "fail",
      txId: txId.toString(),
      notes: `Could not trigger pre-commit timeout after relayer kill: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const relayerRestartedAtMs = Date.now();
  relayer = startRelayer("fi1-kill-lock-after");
  const inactive = await waitForInactive(bridgeAddress, txId, 90_000);
  await stopRelayer(relayer);

  const exec = await executionState(bridgeAddress, txId);
  return {
    caseId: "FI-1",
    runs: 1,
    faultPoint: "relayer killed during lock phase",
    finalPhase: PHASES[exec.phase],
    stateConsistent: timeoutTriggered && !exec.active,
    locksReleasedOrRetryable: inactive ? "rollback delivered or no active execution" : "rollback delivery not observed",
    recoveryTimeMs: inactive ? Date.now() - relayerRestartedAtMs : null,
    status: timeoutTriggered && !exec.active ? "pass" : "fail",
    txId: txId.toString(),
    notes: `Relayer killed ${Date.now() - killedAtMs}ms after request; timeout rollback was ${timeoutTriggered ? "triggered" : "not triggered"}.`,
  };
}

async function runKillAfterCommit(): Promise<FailureResult> {
  const deploymentBc1 = loadDeployment("bc1-1a");
  const deploymentBc2 = loadDeployment("bc2-evm");
  const deploymentBc3 = loadDeployment("bc3-evm");
  const bridge = await ethers.getContractAt("XBridgingContract", deploymentBc1.contracts.xBridgingContract);
  const bridgeAddress = await bridge.getAddress();
  const stateContracts = selectedStateContracts(deploymentBc2, deploymentBc3);
  const txId = BigInt(Date.now()) * 1000n + 2002n;

  await ensureBenchmarkUserFunded();
  let relayer: ChildProcess | null = startRelayer("fi2-kill-after-commit-before");
  await sleep(5000);
  await submitRequest(bridge, stateContracts, txId);

  const sawCommit = await waitForPhase(bridgeAddress, txId, 2, 120_000);
  const killedAtMs = Date.now();
  await stopRelayer(relayer);
  relayer = null;

  if (!sawCommit) {
    const exec = await executionState(bridgeAddress, txId);
    return {
      caseId: "FI-2",
      runs: 1,
      faultPoint: "relayer killed after commit before all updates",
      finalPhase: PHASES[exec.phase],
      stateConsistent: false,
      locksReleasedOrRetryable: "commit not observed",
      recoveryTimeMs: null,
      status: "fail",
      txId: txId.toString(),
      notes: "CommitDecided was not observed before timeout.",
    };
  }

  let timeoutRejected = false;
  try {
    await advanceBlocks(5);
    await bridge.timeoutExecution(txId);
  } catch {
    timeoutRejected = true;
  }

  const restartAtMs = Date.now();
  relayer = startRelayer("fi2-kill-after-commit-after");
  const completed = await waitForInactive(bridgeAddress, txId, 120_000);
  await stopRelayer(relayer);

  const exec = await executionState(bridgeAddress, txId);
  const passed = timeoutRejected && completed && !exec.active && exec.phase === 4;
  return {
    caseId: "FI-2",
    runs: 1,
    faultPoint: "relayer killed after commit before all updates",
    finalPhase: PHASES[exec.phase],
    stateConsistent: passed,
    locksReleasedOrRetryable: passed ? "retry completed" : "retry not completed",
    recoveryTimeMs: completed ? Date.now() - restartAtMs : null,
    status: passed ? "pass" : "fail",
    txId: txId.toString(),
    notes: `Relayer killed ${Date.now() - killedAtMs}ms after CommitDecided; timeout rollback rejected=${timeoutRejected}.`,
  };
}

function writeResult(result: FailureResult) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `failure-xsmart-${result.caseId.toLowerCase()}.json`);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), result }, null, 2), "utf-8");
  console.log(`Saved ${file}`);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  if (network.name !== "bc1" && network.name !== "besu") {
    throw new Error(`XSmart failure injection must run with bc1/besu config, got network=${network.name}`);
  }
  const failureCase = getArg("case", process.env.FAILURE_CASE || "kill-lock") as FailureCase;
  if (failureCase !== "kill-lock" && failureCase !== "kill-after-commit") {
    throw new Error(`Unsupported failure case: ${failureCase}`);
  }
  clearRelayerCheckpoint();
  const result = failureCase === "kill-lock" ? await runKillLock() : await runKillAfterCommit();
  writeResult(result);
  if (result.status !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
