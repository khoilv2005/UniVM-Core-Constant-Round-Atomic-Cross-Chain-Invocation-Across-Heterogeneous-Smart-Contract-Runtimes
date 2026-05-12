import { expect } from "chai";
import { ethers } from "hardhat";

describe("SubstrateStateProofAdapter", function () {
  async function deployAll() {
    const [owner, relayer, user] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [2002n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const adapter = await ethers.deployContract("SubstrateStateProofAdapter", [
      await lightClient.getAddress(),
    ]);
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      3n,
      0n,
    ]);

    const stateful = await ethers.deployContract("CallTreeStatefulTarget");
    const logic = await ethers.deployContract("ProofBackedImportLogic", [
      await stateful.getAddress(),
    ]);

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.setProofAdapter(await adapter.getAddress());
    await bridge.regState(await stateful.getAddress());

    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await logic.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, user, lightClient, adapter, bridge, stateful, logic };
  }

  function metadata(txId: bigint, statefulAddress: string) {
    return {
      chainId: ethers.id("WASM_SUBSTRATE:bc2"),
      contractId: ethers.zeroPadValue(statefulAddress, 32),
      schemaHash: ethers.id("schema:TrainBooking:v1"),
      opId: ethers.zeroPadValue(ethers.toBeHex(txId), 32),
      lockEpoch: 1n,
      stateVersion: 1n,
    };
  }

  function proof(blockNumber: bigint, siblings: string[] = []) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32[]"],
      [blockNumber, siblings],
    );
  }

  it("verifies a finalized Substrate state leaf proof", async function () {
    const { lightClient, adapter, stateful } = await deployAll();
    const lockedState = ethers.toUtf8Bytes("locked-state");
    const meta = metadata(9301n, await stateful.getAddress());

    const leaf = await adapter.stateLeaf(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
    );
    await lightClient.submitBlockHeader(11n, ethers.ZeroHash, leaf, 1n);
    await lightClient.finalizeBlock(11n);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
      proof(11n),
    )).to.equal(true);
  });

  it("rejects state payload drift against a valid finalized root", async function () {
    const { lightClient, adapter, stateful } = await deployAll();
    const meta = metadata(9302n, await stateful.getAddress());
    const lockedState = ethers.toUtf8Bytes("locked-state");
    const tamperedState = ethers.toUtf8Bytes("tampered-state");

    const leaf = await adapter.stateLeaf(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
    );
    await lightClient.submitBlockHeader(12n, ethers.ZeroHash, leaf, 1n);
    await lightClient.finalizeBlock(12n);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      tamperedState,
      proof(12n),
    )).to.equal(false);
  });

  it("executes integrated logic only after proof-backed WASM state import", async function () {
    const { bridge, lightClient, adapter, user, stateful } = await deployAll();
    const txId = 9303n;
    const statefulAddress = await stateful.getAddress();
    const lockedState = ethers.toUtf8Bytes("wasm-locked-state");
    const meta = metadata(txId, statefulAddress);

    const leaf = await adapter.stateLeaf(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
    );
    await lightClient.submitBlockHeader(13n, ethers.ZeroHash, leaf, 1n);
    await lightClient.finalizeBlock(13n);

    await bridge.connect(user).requestLockStates(txId, "travel", [statefulAddress], 2n, 2002n);

    await bridge.connect(user).executeIntegratedLogicWithProofs(
      txId,
      "travel",
      [lockedState],
      [[
        meta.chainId,
        meta.contractId,
        meta.schemaHash,
        meta.opId,
        meta.lockEpoch,
        meta.stateVersion,
        proof(13n),
      ]],
    );

    const exec = await bridge.activeExecutions(txId);
    expect(exec.phase).to.equal(2n);
  });

  it("rejects proof-backed import when the submitted locked state is changed", async function () {
    const { bridge, lightClient, adapter, user, stateful } = await deployAll();
    const txId = 9304n;
    const statefulAddress = await stateful.getAddress();
    const lockedState = ethers.toUtf8Bytes("wasm-locked-state");
    const tamperedState = ethers.toUtf8Bytes("tampered-state");
    const meta = metadata(txId, statefulAddress);

    const leaf = await adapter.stateLeaf(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
    );
    await lightClient.submitBlockHeader(14n, ethers.ZeroHash, leaf, 1n);
    await lightClient.finalizeBlock(14n);

    await bridge.connect(user).requestLockStates(txId, "travel", [statefulAddress], 2n, 2002n);

    await expect(
      bridge.connect(user).executeIntegratedLogicWithProofs(
        txId,
        "travel",
        [tamperedState],
        [[
          meta.chainId,
          meta.contractId,
          meta.schemaHash,
          meta.opId,
          meta.lockEpoch,
          meta.stateVersion,
          proof(14n),
        ]],
      ),
    ).to.be.revertedWith("State import proof failed");
  });
});
