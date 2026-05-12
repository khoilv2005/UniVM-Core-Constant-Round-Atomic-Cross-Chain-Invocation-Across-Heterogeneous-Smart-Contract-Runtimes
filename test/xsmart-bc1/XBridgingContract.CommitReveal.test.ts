import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("XBridgingContract: commit-reveal MEV hardening", function () {
  async function deployAll() {
    const [owner, relayer, user, other] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [1337n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      10n,
      ethers.parseEther("0.01"),
    ]);
    const math = await ethers.deployContract("CallTreeMathTarget");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.regState(await stateful.getAddress());
    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await math.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, user, other, bridge, stateful };
  }

  function opId(value: bigint): string {
    return ethers.zeroPadValue(ethers.toBeHex(value), 32);
  }

  function encodeManifest(
    serviceId: string,
    stateContracts: string[],
    timeoutBlocks: bigint,
    destChainId: bigint,
  ): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address[]", "uint256", "uint256"],
      [serviceId, stateContracts, timeoutBlocks, destChainId],
    );
  }

  async function buildCommit(bridge: any, userAddress: string, stateContracts: string[]) {
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latest?.timestamp ?? 0) + 3600);
    const id = opId(77n);
    const callTree = ethers.hexlify(ethers.toUtf8Bytes("call-tree-placeholder"));
    const lockManifest = encodeManifest("travel", stateContracts, 10n, 2002n);
    const stateVersions = ethers.AbiCoder.defaultAbiCoder().encode(["uint64[]"], [[1n]]);
    const schemaHash = ethers.id("schema:travel:v1");
    const nonce = ethers.id("nonce:77");
    const commitHash = await bridge.computeOperationCommitHash(
      id,
      userAddress,
      callTree,
      lockManifest,
      stateVersions,
      schemaHash,
      nonce,
      deadline,
    );
    return { id, callTree, lockManifest, stateVersions, schemaHash, nonce, deadline, commitHash };
  }

  it("reveals a valid commitment and starts the lock phase", async function () {
    const { bridge, user, stateful } = await deployAll();
    const fee = await bridge.crossChainFee();
    const stateContracts = [await stateful.getAddress()];
    const data = await buildCommit(bridge, await user.getAddress(), stateContracts);

    await expect(bridge.connect(user).submitCommit(data.commitHash, data.deadline))
      .to.emit(bridge, "OperationCommitted")
      .withArgs(data.commitHash, await user.getAddress(), data.deadline);

    await expect(
      bridge.connect(user).revealAndStart(
        data.id,
        data.callTree,
        data.lockManifest,
        data.stateVersions,
        data.schemaHash,
        data.nonce,
        data.deadline,
        { value: fee },
      ),
    )
      .to.emit(bridge, "OperationRevealed")
      .withArgs(data.commitHash, data.id, ethers.keccak256(data.lockManifest))
      .and.to.emit(bridge, "CrossChainLockRequested");

    const exec = await bridge.activeExecutions(77n);
    expect(exec.initiator).to.equal(await user.getAddress());
    expect(exec.active).to.equal(true);
    expect(exec.phase).to.equal(1n);
    expect(await bridge.usedNonces(data.nonce)).to.equal(true);
  });

  it("rejects reveal when the manifest does not match the commitment", async function () {
    const { bridge, user, stateful, other } = await deployAll();
    const fee = await bridge.crossChainFee();
    const data = await buildCommit(bridge, await user.getAddress(), [await stateful.getAddress()]);
    await bridge.connect(user).submitCommit(data.commitHash, data.deadline);

    const wrongManifest = encodeManifest("travel", [await other.getAddress()], 10n, 2002n);
    await expect(
      bridge.connect(user).revealAndStart(
        data.id,
        data.callTree,
        wrongManifest,
        data.stateVersions,
        data.schemaHash,
        data.nonce,
        data.deadline,
        { value: fee },
      ),
    ).to.be.revertedWith("Unknown commit");
  });

  it("rejects replayed reveal and reused nonce", async function () {
    const { bridge, user, stateful } = await deployAll();
    const fee = await bridge.crossChainFee();
    const stateContracts = [await stateful.getAddress()];
    const data = await buildCommit(bridge, await user.getAddress(), stateContracts);
    await bridge.connect(user).submitCommit(data.commitHash, data.deadline);
    await bridge.connect(user).revealAndStart(
      data.id,
      data.callTree,
      data.lockManifest,
      data.stateVersions,
      data.schemaHash,
      data.nonce,
      data.deadline,
      { value: fee },
    );

    await expect(
      bridge.connect(user).revealAndStart(
        data.id,
        data.callTree,
        data.lockManifest,
        data.stateVersions,
        data.schemaHash,
        data.nonce,
        data.deadline,
        { value: fee },
      ),
    ).to.be.revertedWith("Already revealed");

    const other = await buildCommit(bridge, await user.getAddress(), stateContracts);
    const otherNonceSame = await bridge.computeOperationCommitHash(
      opId(78n),
      await user.getAddress(),
      other.callTree,
      other.lockManifest,
      other.stateVersions,
      other.schemaHash,
      data.nonce,
      other.deadline,
    );
    await bridge.connect(user).submitCommit(otherNonceSame, other.deadline);
    await expect(
      bridge.connect(user).revealAndStart(
        opId(78n),
        other.callTree,
        other.lockManifest,
        other.stateVersions,
        other.schemaHash,
        data.nonce,
        other.deadline,
        { value: fee },
      ),
    ).to.be.revertedWith("Nonce used");
  });

  it("expires unrevealed commitments and rejects late reveals", async function () {
    const { bridge, user, stateful } = await deployAll();
    const fee = await bridge.crossChainFee();
    const data = await buildCommit(bridge, await user.getAddress(), [await stateful.getAddress()]);
    await bridge.connect(user).submitCommit(data.commitHash, data.deadline);

    await network.provider.send("evm_setNextBlockTimestamp", [Number(data.deadline) + 1]);
    await network.provider.send("evm_mine");

    await expect(
      bridge.connect(user).revealAndStart(
        data.id,
        data.callTree,
        data.lockManifest,
        data.stateVersions,
        data.schemaHash,
        data.nonce,
        data.deadline,
        { value: fee },
      ),
    ).to.be.revertedWith("Reveal deadline passed");

    await expect(bridge.expireCommit(data.commitHash))
      .to.emit(bridge, "CommitExpired")
      .withArgs(data.commitHash);

    await expect(
      bridge.connect(user).revealAndStart(
        data.id,
        data.callTree,
        data.lockManifest,
        data.stateVersions,
        data.schemaHash,
        data.nonce,
        data.deadline,
        { value: fee },
      ),
    ).to.be.revertedWith("Commit expired");
  });
});
