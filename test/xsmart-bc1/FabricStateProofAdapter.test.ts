import { expect } from "chai";
import { ethers } from "hardhat";

describe("FabricStateProofAdapter", function () {
  async function deployAll() {
    const [owner, relayer, user] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [3003n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const adapter = await ethers.deployContract("FabricStateProofAdapter", [
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

  function metadata(txId: bigint) {
    return {
      chainId: ethers.id("FABRIC:bc3"),
      contractId: ethers.id("chaincode:HotelBooking"),
      schemaHash: ethers.id("schema:HotelBooking:v1"),
      opId: ethers.zeroPadValue(ethers.toBeHex(txId), 32),
      lockEpoch: 1n,
      stateVersion: 1n,
    };
  }

  function fabricFields(overrides: Record<string, string> = {}) {
    return {
      channelId: overrides.channelId ?? ethers.id("channel:travel"),
      chaincodeNameHash: overrides.chaincodeNameHash ?? ethers.id("chaincode:HotelBooking"),
      chaincodeVersionHash: overrides.chaincodeVersionHash ?? ethers.id("chaincode-version:v1"),
      endorsementPolicyHash: overrides.endorsementPolicyHash ?? ethers.id("policy:Org1MSP"),
      rwSetHash: overrides.rwSetHash ?? ethers.id("rwset:locked-state"),
      validationCodeHash: overrides.validationCodeHash ?? ethers.id("validation:VALID"),
      txId: overrides.txId ?? ethers.id("fabric-tx:9301"),
    };
  }

  function proof(blockNumber: bigint, fields = fabricFields(), siblings: string[] = []) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "bytes32[]",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        blockNumber,
        siblings,
        fields.channelId,
        fields.chaincodeNameHash,
        fields.chaincodeVersionHash,
        fields.endorsementPolicyHash,
        fields.rwSetHash,
        fields.validationCodeHash,
        fields.txId,
      ],
    );
  }

  async function submitRoot(
    lightClient: any,
    adapter: any,
    blockNumber: bigint,
    meta: ReturnType<typeof metadata>,
    encodedState: Uint8Array,
    fields = fabricFields(),
  ) {
    const evidenceHash = await adapter.fabricEvidenceHash(
      fields.channelId,
      fields.chaincodeNameHash,
      fields.chaincodeVersionHash,
      fields.endorsementPolicyHash,
      fields.rwSetHash,
      fields.validationCodeHash,
      fields.txId,
    );
    const leaf = await adapter.stateLeaf(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      encodedState,
      evidenceHash,
    );
    await lightClient.submitBlockHeader(blockNumber, ethers.ZeroHash, leaf, 1n);
    await lightClient.finalizeBlock(blockNumber);
  }

  it("verifies a finalized Fabric state evidence proof", async function () {
    const { lightClient, adapter } = await deployAll();
    const meta = metadata(9401n);
    const lockedState = ethers.toUtf8Bytes("fabric-locked-state");
    const fields = fabricFields();

    await submitRoot(lightClient, adapter, 31n, meta, lockedState, fields);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      lockedState,
      proof(31n, fields),
    )).to.equal(true);
  });

  it("rejects channel, chaincode namespace, endorsement policy, and RW-set mismatches", async function () {
    const { lightClient, adapter } = await deployAll();
    const meta = metadata(9402n);
    const lockedState = ethers.toUtf8Bytes("fabric-locked-state");
    const fields = fabricFields();

    await submitRoot(lightClient, adapter, 32n, meta, lockedState, fields);

    const invalidFields = [
      fabricFields({ channelId: ethers.id("channel:wrong") }),
      fabricFields({ chaincodeNameHash: ethers.id("chaincode:wrong") }),
      fabricFields({ endorsementPolicyHash: ethers.id("policy:wrong") }),
      fabricFields({ rwSetHash: ethers.id("rwset:wrong") }),
    ];
    for (const invalid of invalidFields) {
      expect(await adapter.verify(
        meta.chainId,
        meta.contractId,
        meta.schemaHash,
        meta.opId,
        meta.lockEpoch,
        meta.stateVersion,
        lockedState,
        proof(32n, invalid),
      )).to.equal(false);
    }
  });

  it("executes integrated logic only after proof-backed Fabric state import", async function () {
    const { bridge, lightClient, adapter, user, stateful } = await deployAll();
    const txId = 9403n;
    const statefulAddress = await stateful.getAddress();
    const meta = metadata(txId);
    const lockedState = ethers.toUtf8Bytes("fabric-locked-state");
    const fields = fabricFields({ txId: ethers.id("fabric-tx:9403") });

    await submitRoot(lightClient, adapter, 33n, meta, lockedState, fields);
    await bridge.connect(user).requestLockStates(txId, "travel", [statefulAddress], 2n, 3003n);

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
        proof(33n, fields),
      ]],
    );

    const exec = await bridge.activeExecutions(txId);
    expect(exec.phase).to.equal(2n);
  });

  it("rejects Fabric import when the submitted canonical state changes", async function () {
    const { bridge, lightClient, adapter, user, stateful } = await deployAll();
    const txId = 9404n;
    const statefulAddress = await stateful.getAddress();
    const meta = metadata(txId);
    const lockedState = ethers.toUtf8Bytes("fabric-locked-state");
    const tamperedState = ethers.toUtf8Bytes("tampered-fabric-state");
    const fields = fabricFields({ txId: ethers.id("fabric-tx:9404") });

    await submitRoot(lightClient, adapter, 34n, meta, lockedState, fields);
    await bridge.connect(user).requestLockStates(txId, "travel", [statefulAddress], 2n, 3003n);

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
          proof(34n, fields),
        ]],
      ),
    ).to.be.revertedWith("State import proof failed");
  });
});
