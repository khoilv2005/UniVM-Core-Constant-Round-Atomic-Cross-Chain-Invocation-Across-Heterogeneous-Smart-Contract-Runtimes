import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

function functionId(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

describe("ATOM: Fairness Hardening", function () {
  async function deployAll() {
    const [owner, server, judge1, judge2, user, other] = await ethers.getSigners();

    const community = await ethers.deployContract("AtomCommunity", []);
    await community.waitForDeployment();

    await (await community.registerServer(server.address)).wait();
    await (await community.registerJudge(judge1.address)).wait();
    await (await community.registerJudge(judge2.address)).wait();

    const service = await ethers.deployContract("AtomService", [await community.getAddress()]);
    await service.waitForDeployment();

    const remoteRegistry = await ethers.deployContract("AtomRemoteRegistry", []);
    await remoteRegistry.waitForDeployment();

    const entry = await ethers.deployContract("AtomTravelEntry", [
      await service.getAddress(),
      await remoteRegistry.getAddress(),
      server.address,
      2,
      1,
      3,
      4,
    ]);
    await entry.waitForDeployment();

    return {
      owner,
      server,
      judge1,
      judge2,
      user,
      other,
      community,
      service,
      remoteRegistry,
      entry,
    };
  }

  async function registerRemoteWriteFunctions(remoteRegistry: any, target: string) {
    await (
      await remoteRegistry.registerRemoteFunction(
        functionId("hotel-write"),
        2,
        target,
        "hotel.book",
        0,
        "0x00000000",
        "0x11111111",
        "0x22222222",
        "0x33333333",
      )
    ).wait();

    await (
      await remoteRegistry.registerRemoteFunction(
        functionId("train-write"),
        3,
        target,
        "train.book",
        0,
        "0x00000000",
        "0x11111111",
        "0x22222222",
        "0x33333333",
      )
    ).wait();
  }

  async function registerRemoteReadWriteFunctions(remoteRegistry: any, target: string) {
    await registerRemoteWriteFunctions(remoteRegistry, target);
    await (
      await remoteRegistry.registerRemoteFunction(
        functionId("hotel-read"),
        2,
        target,
        "hotel.getRemain",
        1,
        "0x44444444",
        "0x00000000",
        "0x00000000",
        "0x00000000",
      )
    ).wait();
  }

  function proofFor(invokeId: string, operationId = 1n) {
    return {
      invokeId,
      operationId,
      chainId: 2,
      lockDoBlockNumber: 1,
      lockDoTxHash: ethers.keccak256(ethers.toUtf8Bytes(`lock-${invokeId}-${operationId}`)),
      unlockBlockNumber: 2,
      unlockTxHash: ethers.keccak256(ethers.toUtf8Bytes(`unlock-${invokeId}-${operationId}`)),
      undoBlockNumber: 0,
      undoTxHash: ethers.ZeroHash,
      readBlockNumber: 0,
      readTxHash: ethers.ZeroHash,
      dependencyHash: ethers.ZeroHash,
      proofHash: ethers.ZeroHash,
      submitted: true,
    };
  }

  async function signProof(service: any, signer: any, proof: any) {
    const proofHash = await service.hashOperationProof(proof);
    return signer.signMessage(ethers.getBytes(proofHash));
  }

  it("rejects entry invocation when required remote functions are not registered", async function () {
    const { entry, user } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("missing-remotes"));

    await expect(
      entry.connect(user).invokeWriteOnly(invokeId, 1, 1, 1),
    ).to.be.revertedWith("Remote function not registered");
  });

  it("allows entry invocation once remote functions are registered", async function () {
    const { entry, remoteRegistry, service, user } = await deployAll();
    await registerRemoteWriteFunctions(remoteRegistry, await service.getAddress());

    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("registered-remotes"));
    await expect(entry.connect(user).invokeWriteOnly(invokeId, 1, 1, 1))
      .to.emit(entry, "WriteOnlyInvocationRequested");

    const invocation = await service.getInvocation(invokeId);
    expect(invocation.server).to.equal(await entry.atomServer());
    expect(invocation.totalOperationCount).to.equal(2n);
    expect(invocation.status).to.equal(2n);
  });

  it("enforces the service deadline for proof submission", async function () {
    const { service, server } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("service-deadline"));

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        2,
        4,
        1,
      )
    ).wait();

    await mine(3);

    await expect(
      service.connect(server).submitOperationProof(
        invokeId,
        proofFor(invokeId),
        await signProof(service, server, proofFor(invokeId)),
      ),
    ).to.be.revertedWith("Service deadline passed");
  });

  it("enforces the audit deadline for judge voting", async function () {
    const { service, server, judge1 } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("audit-deadline"));

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        3,
        2,
        1,
      )
    ).wait();
    await (
      await service.connect(
        server
      ).submitOperationProof(invokeId, proofFor(invokeId), await signProof(service, server, proofFor(invokeId)))
    ).wait();
    await (await service.connect(server).markProofSubmissionComplete(invokeId)).wait();

    await mine(3);

    await expect(
      service.connect(judge1).submitJudgeVote(invokeId, true, ethers.keccak256(ethers.toUtf8Bytes("audit"))),
    ).to.be.revertedWith("Audit deadline passed");
  });

  it("rewards the server and matching judges for a valid invocation", async function () {
    const { service, server, judge1, judge2 } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("valid-settlement"));

    await (await service.fundRewardPool({ value: ethers.parseEther("1") })).wait();
    await (await service.connect(server).depositBond({ value: ethers.parseEther("0.2") })).wait();
    await (await service.connect(judge1).depositBond({ value: ethers.parseEther("0.1") })).wait();
    await (await service.connect(judge2).depositBond({ value: ethers.parseEther("0.1") })).wait();

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        3,
        4,
        1,
      )
    ).wait();

    await (
      await service.connect(
        server
      ).submitOperationProof(invokeId, proofFor(invokeId), await signProof(service, server, proofFor(invokeId)))
    ).wait();
    await (await service.connect(server).markProofSubmissionComplete(invokeId)).wait();
    await (await service.connect(judge1).submitJudgeVote(invokeId, true, ethers.keccak256(ethers.toUtf8Bytes("audit-valid")))).wait();
    await (await service.finalizeInvocation(invokeId)).wait();

    expect(await service.pendingWithdrawals(server.address)).to.equal(ethers.parseEther("0.01"));
    expect(await service.pendingWithdrawals(judge1.address)).to.equal(ethers.parseEther("0.005"));
    expect(await service.pendingWithdrawals(judge2.address)).to.equal(0n);
    expect(await service.depositedBonds(server.address)).to.equal(ethers.parseEther("0.2"));
    expect(await service.depositedBonds(judge1.address)).to.equal(ethers.parseEther("0.1"));
    expect(await service.depositedBonds(judge2.address)).to.equal(ethers.parseEther("0.09"));

    const invocation = await service.getInvocation(invokeId);
    expect(invocation.status).to.equal(7n);
  });

  it("slashes the server and non-matching judges for an invalid invocation", async function () {
    const { service, server, judge1, judge2 } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("invalid-settlement"));

    await (await service.fundRewardPool({ value: ethers.parseEther("1") })).wait();
    await (await service.connect(server).depositBond({ value: ethers.parseEther("0.2") })).wait();
    await (await service.connect(judge1).depositBond({ value: ethers.parseEther("0.1") })).wait();
    await (await service.connect(judge2).depositBond({ value: ethers.parseEther("0.1") })).wait();

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        3,
        4,
        1,
      )
    ).wait();

    await (
      await service.connect(
        server
      ).submitOperationProof(invokeId, proofFor(invokeId), await signProof(service, server, proofFor(invokeId)))
    ).wait();
    await (await service.connect(server).markProofSubmissionComplete(invokeId)).wait();
    await (await service.connect(judge1).submitJudgeVote(invokeId, false, ethers.keccak256(ethers.toUtf8Bytes("audit-invalid")))).wait();
    await (await service.finalizeInvocation(invokeId)).wait();

    expect(await service.depositedBonds(server.address)).to.equal(ethers.parseEther("0.18"));
    expect(await service.pendingWithdrawals(judge1.address)).to.equal(ethers.parseEther("0.005"));
    expect(await service.depositedBonds(judge2.address)).to.equal(ethers.parseEther("0.09"));
    expect(await service.pendingWithdrawals(server.address)).to.equal(0n);
    expect(await service.penaltyPool()).to.equal(ethers.parseEther("0.03"));
  });

  it("rejects proof submission from a non-server even when remotes are registered", async function () {
    const { entry, remoteRegistry, service, user, other } = await deployAll();
    await registerRemoteReadWriteFunctions(remoteRegistry, await service.getAddress());

    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("non-server-proof"));
    await (await entry.connect(user).invokeReadWrite(invokeId, 1, 1, 1)).wait();

    await expect(
      service.connect(other).submitOperationProof(
        invokeId,
        proofFor(invokeId),
        await signProof(service, other, proofFor(invokeId)),
      ),
    ).to.be.revertedWith("Not invocation server");
  });

  it("rejects operation proofs signed by a non-server key", async function () {
    const { service, server, other } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("bad-proof-signature"));

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        3,
        4,
        1,
      )
    ).wait();

    const proof = proofFor(invokeId);
    await expect(
      service.connect(server).submitOperationProof(invokeId, proof, await signProof(service, other, proof)),
    ).to.be.revertedWith("Invalid proof signature");
  });

  it("rejects proofs that skip the dependency chain", async function () {
    const { service, server } = await deployAll();
    const invokeId = ethers.keccak256(ethers.toUtf8Bytes("broken-proof-chain"));

    await (
      await service.initInvocation(
        invokeId,
        ethers.keccak256(ethers.toUtf8Bytes("workflow")),
        server.address,
        server.address,
        2,
        1,
        3,
        4,
        2,
      )
    ).wait();

    const secondProof = proofFor(invokeId, 2n);
    await expect(
      service.connect(server).submitOperationProof(invokeId, secondProof, await signProof(service, server, secondProof)),
    ).to.be.revertedWith("Missing dependency proof");
  });
});
