import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type TreeNode = {
  contractAddr: string;
  selector: string;
  args: string;
  argChildIdx: bigint[];
  children: bigint[];
};

type FailureResult = {
  caseId: string;
  faultPoint: string;
  finalPhase: string;
  stateConsistent: boolean;
  locksReleasedOrRetryable: string;
  recoveryTimeMs: number | null;
  status: "pass" | "fail";
  notes: string;
};

const MAX = (1n << 256n) - 1n;
const phaseName = ["None", "Requested", "CommitDecided", "AbortDecided", "Completed", "RolledBack"];
const failureResults: FailureResult[] = [];

function word(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function encodeArgs(...values: bigint[]): string {
  return ethers.concat(values.map(word));
}

function encodeTree(nodes: TreeNode[], rootIndex: bigint): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    [
      "tuple(address contractAddr, bytes4 selector, bytes args, uint256[] argChildIdx, uint256[] children)[]",
      "uint256",
    ],
    [nodes, rootIndex],
  );
}

async function writeFailureArtifacts() {
  const outDir = path.join(__dirname, "..", "..", "benchmark-results", "failure-injection");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "failure-xsmart-unit.json");
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: "hardhat-xsmart-bc1",
    scope: "deterministic failure injection unit suite",
    summary: {
      cases: failureResults.length,
      passed: failureResults.filter((row) => row.status === "pass").length,
      failed: failureResults.filter((row) => row.status === "fail").length,
    },
    cases: failureResults,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

}

describe("XBridgingContract Failure Injection", function () {
  async function deployAll() {
    const [owner, relayer, user] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [2002n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      3n,
      0n,
    ]);

    const math = await ethers.deployContract("CallTreeMathTarget");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");
    const lHotel = await ethers.deployContract("LHotel");
    const sHotel = await ethers.deployContract("SHotel", [
      10n,
      20n,
      await lHotel.getAddress(),
      await bridge.getAddress(),
      1n,
    ]);

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.regState(await stateful.getAddress());
    await bridge.regState(await sHotel.getAddress());

    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await math.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, user, lightClient, relayerManager, registry, bridge, math, stateful, sHotel };
  }

  async function registerTranslation(registry: any, translated: string, label: string, irLabel = label) {
    const sourceChainId = 2002n;
    const sourceHash = ethers.id(`source:${label}`);
    const irHash = ethers.id(`ir:${irLabel}`);
    await registry.register(sourceChainId, sourceHash, irHash, translated, ethers.ZeroHash);
    const key = await registry.keyFor(sourceChainId, sourceHash);
    return { key, irHash };
  }

  async function commitSingleNode(bridge: any, registry: any, user: any, math: any, stateContracts: string[], txId: bigint) {
    const translation = await registerTranslation(registry, await math.getAddress(), `math:${txId}`);
    await bridge.connect(user).requestLockStates(txId, "travel", stateContracts, 2n, 2002n);

    const nodes: TreeNode[] = [
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(13n),
        argChildIdx: [MAX],
        children: [],
      },
    ];
    await bridge.connect(user).executeIntegratedCallTree(
      txId,
      "travel",
      encodeTree(nodes, 0n),
      [translation.key],
      [translation.irHash],
    );
  }

  after(async function () {
    await writeFailureArtifacts();
  });

  it("FI-3 rejects malformed proof/message before state mutation", async function () {
    const { bridge, registry, relayer, user, lightClient, math, stateful } = await deployAll();
    const txId = 3003n;
    const statefulAddress = await stateful.getAddress();
    await commitSingleNode(bridge, registry, user, math, [statefulAddress], txId);

    const execBefore = await bridge.activeExecutions(txId);
    const malformedReceipt = ethers.id("malformed-receipt");
    const receiptsRoot = ethers.id("different-root");
    await lightClient.submitBlockHeader(1n, receiptsRoot, ethers.ZeroHash, 1n);
    await lightClient.finalizeBlock(1n);

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ethers.id("bad-proof"),
        true,
        1n,
        [],
        malformedReceipt,
      ),
    ).to.be.revertedWith("Merkle proof failed");

    const execAfter = await bridge.activeExecutions(txId);
    expect(execAfter.phase).to.equal(execBefore.phase);
    expect(execAfter.updateAckCount).to.equal(0n);

    failureResults.push({
      caseId: "FI-3",
      faultPoint: "malformed proof/message",
      finalPhase: phaseName[Number(execAfter.phase)],
      stateConsistent: true,
      locksReleasedOrRetryable: "phase unchanged; no ACK recorded",
      recoveryTimeMs: null,
      status: "pass",
      notes: "Invalid Merkle evidence reverts before update ACK mutation.",
    });
  });

  it("FI-4 rejects duplicate update ACKs", async function () {
    const { bridge, registry, relayer, user, math, stateful } = await deployAll();
    const secondStateful = await ethers.deployContract("CallTreeStatefulTarget");
    await bridge.regState(await secondStateful.getAddress());
    const txId = 4004n;
    await commitSingleNode(bridge, registry, user, math, [await stateful.getAddress(), await secondStateful.getAddress()], txId);

    const ackKey = ethers.id("bc2:stateful:duplicate");
    await bridge.connect(relayer).recordUpdateAckAndMaybeComplete(txId, ackKey, true, 0n, [], ethers.ZeroHash);

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(txId, ackKey, true, 0n, [], ethers.ZeroHash),
    ).to.be.revertedWith("Ack already recorded");

    const execAfter = await bridge.activeExecutions(txId);
    expect(execAfter.active).to.equal(true);
    expect(execAfter.phase).to.equal(2n);
    expect(execAfter.updateAckCount).to.equal(1n);

    failureResults.push({
      caseId: "FI-4",
      faultPoint: "duplicate ACK",
      finalPhase: phaseName[Number(execAfter.phase)],
      stateConsistent: true,
      locksReleasedOrRetryable: "retryable; duplicate cannot increase ACK count",
      recoveryTimeMs: null,
      status: "pass",
      notes: "Duplicate ACK key is rejected while operation remains CommitDecided waiting for the missing endpoint.",
    });
  });

  it("FI-5 keeps committed operation retryable when one invoked-chain update fails", async function () {
    const { bridge, registry, relayer, user, math, stateful } = await deployAll();
    const txId = 5005n;
    const statefulAddress = await stateful.getAddress();
    await commitSingleNode(bridge, registry, user, math, [statefulAddress], txId);

    const storedBefore = await stateful.stored();
    const updateTxKey = ethers.keccak256(ethers.solidityPacked(["uint256", "uint256", "string"], [txId, 1337n, "update"]));

    await expect(
      bridge.connect(relayer).receiveUpdateRequest(
        txId,
        [statefulAddress],
        [ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [99n])],
        0n,
        [],
        ethers.ZeroHash,
      ),
    ).to.be.reverted;

    const execAfter = await bridge.activeExecutions(txId);
    expect(execAfter.active).to.equal(true);
    expect(execAfter.phase).to.equal(2n);
    expect(await bridge.processedCrossChainTxs(updateTxKey)).to.equal(false);
    expect(await stateful.stored()).to.equal(storedBefore);
    await ethers.provider.send("hardhat_mine", ["0x05"]);
    await expect(bridge.timeoutExecution(txId)).to.be.revertedWith("Commit already decided");

    failureResults.push({
      caseId: "FI-5",
      faultPoint: "invoked-chain update revert",
      finalPhase: phaseName[Number(execAfter.phase)],
      stateConsistent: true,
      locksReleasedOrRetryable: "retryable after CommitDecided",
      recoveryTimeMs: null,
      status: "pass",
      notes: "Failed update does not process the update key, does not mutate target state, and cannot trigger timeout rollback after commit.",
    });
  });

  it("FI-6 times out before commit and releases acquired locks via rollback", async function () {
    const { bridge, relayer, user, sHotel } = await deployAll();
    const txId = 6006n;
    const sHotelAddress = await sHotel.getAddress();
    const lockArgs = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [txId, 1n, 5n]);

    await bridge.connect(user).requestLockStates(txId, "travel", [sHotelAddress], 1n, 2002n);
    await bridge.connect(relayer).receiveLockRequest(txId, [sHotelAddress], [lockArgs], 5n, 0n, [], ethers.ZeroHash);
    expect(await sHotel.isStateLocked(txId)).to.equal(true);

    await ethers.provider.send("hardhat_mine", ["0x05"]);
    const rollbackStartedAt = Date.now();
    await expect(bridge.timeoutExecution(txId)).to.emit(bridge, "CrossChainRollback");
    await bridge.connect(relayer).receiveRollbackRequest(txId, [sHotelAddress], 0n, [], ethers.ZeroHash);
    const unlockElapsedMs = Date.now() - rollbackStartedAt;

    const execAfter = await bridge.activeExecutions(txId);
    expect(execAfter.active).to.equal(false);
    expect(execAfter.phase).to.equal(3n);
    expect(await sHotel.isStateLocked(txId)).to.equal(false);
    await expect(
      bridge.connect(relayer).requestUpdate(txId, [sHotelAddress], [lockArgs]),
    ).to.be.revertedWith("Not active");

    failureResults.push({
      caseId: "FI-6",
      faultPoint: "timeout before commit",
      finalPhase: phaseName[Number(execAfter.phase)],
      stateConsistent: true,
      locksReleasedOrRetryable: "released",
      recoveryTimeMs: unlockElapsedMs,
      status: "pass",
      notes: "Timeout in Requested emits rollback; rollback delivery unlocks remote state and later update is rejected.",
    });
  });
});
