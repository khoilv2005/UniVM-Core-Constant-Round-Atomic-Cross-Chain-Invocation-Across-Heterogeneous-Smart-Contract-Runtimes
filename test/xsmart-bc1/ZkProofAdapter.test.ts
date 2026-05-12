import { expect } from "chai";
import { ethers } from "hardhat";

describe("ZkProofAdapter", function () {
  const vkey = ethers.id("xsmart-sp1-program-vkey");
  const imageId = ethers.id("xsmart-risc0-image-id");

  function metadata(txId: bigint) {
    return {
      chainId: ethers.id("WASM_SUBSTRATE:bc2"),
      contractId: ethers.id("contract:xbridge_bc2"),
      schemaHash: ethers.id("schema:TrainBooking:v1"),
      opId: ethers.zeroPadValue(ethers.toBeHex(txId), 32),
      lockEpoch: 1n,
      stateVersion: 7n,
    };
  }

  async function publicValues(adapter: any, meta: ReturnType<typeof metadata>, encodedState: Uint8Array) {
    return adapter.publicValues(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      encodedState,
    );
  }

  function proof(publicValuesBytes: string, proofBytes: string) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "bytes"],
      [publicValuesBytes, proofBytes],
    );
  }

  it("verifies SP1 proofs through the configured SP1 verifier", async function () {
    const verifier = await ethers.deployContract("MockSP1Verifier");
    const adapter = await ethers.deployContract("ZkProofAdapter", [
      await verifier.getAddress(),
      vkey,
      0,
    ]);
    const meta = metadata(9501n);
    const encodedState = ethers.toUtf8Bytes("wasm-state");
    const publicValuesBytes = await publicValues(adapter, meta, encodedState);
    const proofBytes = ethers.hexlify(ethers.toUtf8Bytes("sp1-proof"));

    await verifier.setProof(vkey, publicValuesBytes, proofBytes, true);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      encodedState,
      proof(publicValuesBytes, proofBytes),
    )).to.equal(true);
  });

  it("rejects SP1 proofs when the imported state differs from public values", async function () {
    const verifier = await ethers.deployContract("MockSP1Verifier");
    const adapter = await ethers.deployContract("ZkProofAdapter", [
      await verifier.getAddress(),
      vkey,
      0,
    ]);
    const meta = metadata(9502n);
    const encodedState = ethers.toUtf8Bytes("wasm-state");
    const tamperedState = ethers.toUtf8Bytes("tampered-state");
    const publicValuesBytes = await publicValues(adapter, meta, encodedState);
    const proofBytes = ethers.hexlify(ethers.toUtf8Bytes("sp1-proof"));

    await verifier.setProof(vkey, publicValuesBytes, proofBytes, true);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      tamperedState,
      proof(publicValuesBytes, proofBytes),
    )).to.equal(false);
  });

  it("verifies RISC Zero receipts through journal digest binding", async function () {
    const verifier = await ethers.deployContract("MockRiscZeroVerifier");
    const adapter = await ethers.deployContract("ZkProofAdapter", [
      await verifier.getAddress(),
      imageId,
      1,
    ]);
    const meta = metadata(9503n);
    const encodedState = ethers.toUtf8Bytes("fabric-state");
    const journal = await publicValues(adapter, meta, encodedState);
    const seal = ethers.hexlify(ethers.toUtf8Bytes("risc0-seal"));
    const journalDigest = ethers.sha256(journal);

    await verifier.setReceipt(seal, imageId, journalDigest, true);

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      encodedState,
      proof(journal, seal),
    )).to.equal(true);
  });

  it("rejects RISC Zero receipts that the verifier does not accept", async function () {
    const verifier = await ethers.deployContract("MockRiscZeroVerifier");
    const adapter = await ethers.deployContract("ZkProofAdapter", [
      await verifier.getAddress(),
      imageId,
      1,
    ]);
    const meta = metadata(9504n);
    const encodedState = ethers.toUtf8Bytes("fabric-state");
    const journal = await publicValues(adapter, meta, encodedState);
    const seal = ethers.hexlify(ethers.toUtf8Bytes("risc0-seal"));

    expect(await adapter.verify(
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      encodedState,
      proof(journal, seal),
    )).to.equal(false);
  });
});
