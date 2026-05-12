import { expect } from "chai";
import { ethers } from "hardhat";

type TreeNode = {
  contractAddr: string;
  selector: string;
  args: string;
  argChildIdx: bigint[];
  children: bigint[];
};

const MAX = (1n << 256n) - 1n;

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

describe("XSmart proof-adapter boundary", function () {
  async function deployAll() {
    const [owner, relayer, user] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [2002n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const componentAdapter = await ethers.deployContract("ComponentVerifiedAdapter", [
      await lightClient.getAddress(),
    ]);
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      3n,
      0n,
    ]);

    const math = await ethers.deployContract("CallTreeMathTarget");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.setProofAdapter(await componentAdapter.getAddress());
    await bridge.regState(await stateful.getAddress());

    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await math.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, user, lightClient, registry, componentAdapter, bridge, math, stateful };
  }

  async function commitSingleNode(bridge: any, registry: any, user: any, math: any, stateContracts: string[], txId: bigint) {
    const sourceChainId = 2002n;
    const sourceHash = ethers.id(`source:proof-adapter:${txId}`);
    const irHash = ethers.id(`ir:proof-adapter:${txId}`);
    await registry.register(sourceChainId, sourceHash, irHash, await math.getAddress(), ethers.ZeroHash);
    const key = await registry.keyFor(sourceChainId, sourceHash);

    await bridge.connect(user).requestLockStates(txId, "travel", stateContracts, 2n, 2002n);

    const nodes: TreeNode[] = [
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(17n),
        argChildIdx: [MAX],
        children: [],
      },
    ];
    await bridge.connect(user).executeIntegratedCallTree(
      txId,
      "travel",
      encodeTree(nodes, 0n),
      [key],
      [irHash],
    );
  }

  it("component adapter verifies the current light-client receipt proof format", async function () {
    const { lightClient, componentAdapter } = await deployAll();
    const receiptHash = ethers.id("valid-component-proof");
    await lightClient.submitBlockHeader(1n, receiptHash, ethers.ZeroHash, 1n);
    await lightClient.finalizeBlock(1n);

    const proof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "bytes32[]"],
      [1n, receiptHash, []],
    );

    expect(await componentAdapter.verify(
      ethers.ZeroHash,
      ethers.ZeroHash,
      ethers.ZeroHash,
      ethers.ZeroHash,
      0,
      0,
      "0x",
      proof,
    )).to.equal(true);
  });

  it("composite adapter routes component, WASM/Substrate, and Fabric evidence", async function () {
    const { lightClient } = await deployAll();
    const componentAdapter = await ethers.deployContract("ComponentVerifiedAdapter", [
      await lightClient.getAddress(),
    ]);
    const substrateAdapter = await ethers.deployContract("SubstrateStateProofAdapter", [
      await lightClient.getAddress(),
    ]);
    const fabricAdapter = await ethers.deployContract("FabricStateProofAdapter", [
      await lightClient.getAddress(),
    ]);
    const composite = await ethers.deployContract("CompositeProofAdapter", [
      await componentAdapter.getAddress(),
      await substrateAdapter.getAddress(),
      await fabricAdapter.getAddress(),
    ]);

    const receiptHash = ethers.id("composite-component-proof");
    await lightClient.submitBlockHeader(20n, receiptHash, ethers.ZeroHash, 1n);
    await lightClient.finalizeBlock(20n);
    const componentProof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "bytes32[]"],
      [20n, receiptHash, []],
    );
    expect(await composite.verify(
      ethers.id("EVM:bc1"),
      ethers.ZeroHash,
      ethers.ZeroHash,
      ethers.ZeroHash,
      0,
      0,
      "0x",
      componentProof,
    )).to.equal(true);

    const substrateState = ethers.toUtf8Bytes("wasm-state");
    const substrateMeta = {
      chainId: ethers.id("WASM_SUBSTRATE:bc2"),
      contractId: ethers.id("contract:train"),
      schemaHash: ethers.id("schema:train:v1"),
      opId: ethers.id("op:substrate"),
      lockEpoch: 1n,
      stateVersion: 1n,
    };
    const substrateLeaf = await substrateAdapter.stateLeaf(
      substrateMeta.chainId,
      substrateMeta.contractId,
      substrateMeta.schemaHash,
      substrateMeta.opId,
      substrateMeta.lockEpoch,
      substrateMeta.stateVersion,
      substrateState,
    );
    await lightClient.submitBlockHeader(21n, ethers.ZeroHash, substrateLeaf, 1n);
    await lightClient.finalizeBlock(21n);
    const substrateProof = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32[]"], [21n, []]);
    expect(await composite.verify(
      substrateMeta.chainId,
      substrateMeta.contractId,
      substrateMeta.schemaHash,
      substrateMeta.opId,
      substrateMeta.lockEpoch,
      substrateMeta.stateVersion,
      substrateState,
      substrateProof,
    )).to.equal(true);

    const fabricState = ethers.toUtf8Bytes("fabric-state");
    const fabricMeta = {
      chainId: ethers.id("FABRIC:bc3"),
      contractId: ethers.id("chaincode:HotelBooking"),
      schemaHash: ethers.id("schema:hotel:v1"),
      opId: ethers.id("op:fabric"),
      lockEpoch: 1n,
      stateVersion: 1n,
    };
    const fields = {
      channelId: ethers.id("channel:travel"),
      chaincodeNameHash: ethers.id("chaincode:HotelBooking"),
      chaincodeVersionHash: ethers.id("chaincode-version:v1"),
      endorsementPolicyHash: ethers.id("policy:Org1MSP"),
      rwSetHash: ethers.id("rwset:fabric-state"),
      validationCodeHash: ethers.id("validation:VALID"),
      txId: ethers.id("fabric-tx:composite"),
    };
    const evidenceHash = await fabricAdapter.fabricEvidenceHash(
      fields.channelId,
      fields.chaincodeNameHash,
      fields.chaincodeVersionHash,
      fields.endorsementPolicyHash,
      fields.rwSetHash,
      fields.validationCodeHash,
      fields.txId,
    );
    const fabricLeaf = await fabricAdapter.stateLeaf(
      fabricMeta.chainId,
      fabricMeta.contractId,
      fabricMeta.schemaHash,
      fabricMeta.opId,
      fabricMeta.lockEpoch,
      fabricMeta.stateVersion,
      fabricState,
      evidenceHash,
    );
    await lightClient.submitBlockHeader(22n, ethers.ZeroHash, fabricLeaf, 1n);
    await lightClient.finalizeBlock(22n);
    const fabricProof = ethers.AbiCoder.defaultAbiCoder().encode(
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
        22n,
        [],
        fields.channelId,
        fields.chaincodeNameHash,
        fields.chaincodeVersionHash,
        fields.endorsementPolicyHash,
        fields.rwSetHash,
        fields.validationCodeHash,
        fields.txId,
      ],
    );
    expect(await composite.verify(
      fabricMeta.chainId,
      fabricMeta.contractId,
      fabricMeta.schemaHash,
      fabricMeta.opId,
      fabricMeta.lockEpoch,
      fabricMeta.stateVersion,
      fabricState,
      fabricProof,
    )).to.equal(true);
  });

  it("routes bridge evidence checks through the configured adapter", async function () {
    const { bridge, registry, relayer, user, lightClient, math, stateful } = await deployAll();
    const txId = 9201n;
    await commitSingleNode(bridge, registry, user, math, [await stateful.getAddress()], txId);

    const malformedReceipt = ethers.id("adapter-malformed-receipt");
    const receiptsRoot = ethers.id("adapter-different-root");
    await lightClient.submitBlockHeader(2n, receiptsRoot, ethers.ZeroHash, 1n);
    await lightClient.finalizeBlock(2n);

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ethers.id("adapter-bad-ack"),
        true,
        2n,
        [],
        malformedReceipt,
      ),
    ).to.be.revertedWith("Proof adapter failed");
  });

  it("accepts ACK evidence through the configured component adapter", async function () {
    const { bridge, registry, relayer, user, lightClient, math, stateful } = await deployAll();
    const txId = 9202n;
    await commitSingleNode(bridge, registry, user, math, [await stateful.getAddress()], txId);

    const receiptHash = ethers.id("adapter-valid-ack");
    await lightClient.submitBlockHeader(3n, receiptHash, ethers.ZeroHash, 1n);
    await lightClient.finalizeBlock(3n);

    await bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
      txId,
      ethers.id("adapter-good-ack"),
      true,
      3n,
      [],
      receiptHash,
    );

    const exec = await bridge.activeExecutions(txId);
    expect(exec.phase).to.equal(4n);
  });
});
