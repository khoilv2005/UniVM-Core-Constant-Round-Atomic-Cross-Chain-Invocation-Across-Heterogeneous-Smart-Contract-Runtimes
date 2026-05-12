/**
 * RQ3 proof-adapter verifier-gas and receipt-latency microbenchmark.
 *
 * Measures the current ZkProofAdapter binding path with mock SP1/RISC Zero
 * verifiers and a BN254 four-pairing SP1-compatible verifier stub. The pairing
 * stub exercises the EVM precompile but does not prove a production zkVM trace.
 *
 * Usage:
 *   $env:PROOF_SIZES_BYTES="256,1024,4096,16384"
 *   $env:BC1_RPC_URL="http://35.185.111.61:8545"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-zk-verifier-gas.ts --network besu
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Backend = "sp1-mock" | "risc0-mock" | "sp1-bn254-4pair-stub";

type Row = {
  backend: Backend;
  proofBytes: number;
  adapterProofBytes: number;
  publicValuesBytes: number;
  encodedStateBytes: number;
  adapterVerifyGas: number;
  verifierDirectGas: number;
  adapterVerifyLatencyMs: number;
  verifierDirectLatencyMs: number;
  adapterTxHash: string;
  verifierTxHash: string;
};

const coder = ethers.AbiCoder.defaultAbiCoder();
const vkey = ethers.id("xsmart-sp1-program-vkey");
const imageId = ethers.id("xsmart-risc0-image-id");

function getArg(name: string, fallback: string): string {
  const envName = name.toUpperCase().replace(/-/g, "_");
  const env = process.env[envName];
  if (env && env.trim() !== "") return env.trim();
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function bytePattern(size: number, seed: number): string {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 37 + seed * 19 + 11) & 0xff;
  }
  return ethers.hexlify(bytes);
}

function adapterProof(publicValuesBytes: string, proofBytes: string): string {
  return coder.encode(["bytes", "bytes"], [publicValuesBytes, proofBytes]);
}

function metadata(seed: number) {
  return {
    chainId: ethers.id("WASM_SUBSTRATE:bc2"),
    contractId: ethers.id("contract:xbridge_bc2"),
    schemaHash: ethers.id("schema:TrainBooking:v1"),
    opId: ethers.zeroPadValue(ethers.toBeHex(9700 + seed), 32),
    lockEpoch: 1n,
    stateVersion: BigInt(7 + seed),
  };
}

async function waitMeasured(txPromise: Promise<any>) {
  const started = Date.now();
  const tx = await txPromise;
  const receipt = await tx.wait();
  return {
    gasUsed: Number(receipt.gasUsed),
    latencyMs: Date.now() - started,
    txHash: receipt.hash ?? tx.hash,
  };
}

async function publicValues(adapter: any, meta: ReturnType<typeof metadata>, encodedState: string): Promise<string> {
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

async function measureSp1Mock(ctx: any, proofSize: number, seed: number): Promise<Row> {
  const meta = metadata(seed);
  const encodedState = bytePattern(128, seed);
  const publicValuesBytes = await publicValues(ctx.sp1Adapter, meta, encodedState);
  const proofBytes = bytePattern(proofSize, seed + 100);
  const packedProof = adapterProof(publicValuesBytes, proofBytes);
  await (await ctx.sp1Verifier.setProof(vkey, publicValuesBytes, proofBytes, true)).wait();

  const direct = await waitMeasured(ctx.harness.verifySp1Tx(
    await ctx.sp1Verifier.getAddress(),
    vkey,
    publicValuesBytes,
    proofBytes,
  ));
  const adapter = await waitMeasured(ctx.harness.verifyAdapterTx(
    await ctx.sp1Adapter.getAddress(),
    meta.chainId,
    meta.contractId,
    meta.schemaHash,
    meta.opId,
    meta.lockEpoch,
    meta.stateVersion,
    encodedState,
    packedProof,
  ));
  return {
    backend: "sp1-mock",
    proofBytes: ethers.getBytes(proofBytes).length,
    adapterProofBytes: ethers.getBytes(packedProof).length,
    publicValuesBytes: ethers.getBytes(publicValuesBytes).length,
    encodedStateBytes: ethers.getBytes(encodedState).length,
    adapterVerifyGas: adapter.gasUsed,
    verifierDirectGas: direct.gasUsed,
    adapterVerifyLatencyMs: adapter.latencyMs,
    verifierDirectLatencyMs: direct.latencyMs,
    adapterTxHash: adapter.txHash,
    verifierTxHash: direct.txHash,
  };
}

async function measureRisc0Mock(ctx: any, proofSize: number, seed: number): Promise<Row> {
  const meta = metadata(seed);
  const encodedState = bytePattern(128, seed);
  const journal = await publicValues(ctx.risc0Adapter, meta, encodedState);
  const seal = bytePattern(proofSize, seed + 200);
  const packedProof = adapterProof(journal, seal);
  const journalDigest = ethers.sha256(journal);
  await (await ctx.risc0Verifier.setReceipt(seal, imageId, journalDigest, true)).wait();

  const direct = await waitMeasured(ctx.harness.verifyRiscZeroTx(
    await ctx.risc0Verifier.getAddress(),
    seal,
    imageId,
    journalDigest,
  ));
  const adapter = await waitMeasured(ctx.harness.verifyAdapterTx(
    await ctx.risc0Adapter.getAddress(),
    meta.chainId,
    meta.contractId,
    meta.schemaHash,
    meta.opId,
    meta.lockEpoch,
    meta.stateVersion,
    encodedState,
    packedProof,
  ));
  return {
    backend: "risc0-mock",
    proofBytes: ethers.getBytes(seal).length,
    adapterProofBytes: ethers.getBytes(packedProof).length,
    publicValuesBytes: ethers.getBytes(journal).length,
    encodedStateBytes: ethers.getBytes(encodedState).length,
    adapterVerifyGas: adapter.gasUsed,
    verifierDirectGas: direct.gasUsed,
    adapterVerifyLatencyMs: adapter.latencyMs,
    verifierDirectLatencyMs: direct.latencyMs,
    adapterTxHash: adapter.txHash,
    verifierTxHash: direct.txHash,
  };
}

async function measurePairingStub(ctx: any, proofSize: number, seed: number): Promise<Row> {
  const meta = metadata(seed);
  const encodedState = bytePattern(128, seed);
  const publicValuesBytes = await publicValues(ctx.pairingAdapter, meta, encodedState);
  const proofBytes = bytePattern(proofSize, seed + 300);
  const packedProof = adapterProof(publicValuesBytes, proofBytes);

  const direct = await waitMeasured(ctx.harness.verifySp1Tx(
    await ctx.pairingVerifier.getAddress(),
    vkey,
    publicValuesBytes,
    proofBytes,
  ));
  const adapter = await waitMeasured(ctx.harness.verifyAdapterTx(
    await ctx.pairingAdapter.getAddress(),
    meta.chainId,
    meta.contractId,
    meta.schemaHash,
    meta.opId,
    meta.lockEpoch,
    meta.stateVersion,
    encodedState,
    packedProof,
  ));
  return {
    backend: "sp1-bn254-4pair-stub",
    proofBytes: ethers.getBytes(proofBytes).length,
    adapterProofBytes: ethers.getBytes(packedProof).length,
    publicValuesBytes: ethers.getBytes(publicValuesBytes).length,
    encodedStateBytes: ethers.getBytes(encodedState).length,
    adapterVerifyGas: adapter.gasUsed,
    verifierDirectGas: direct.gasUsed,
    adapterVerifyLatencyMs: adapter.latencyMs,
    verifierDirectLatencyMs: direct.latencyMs,
    adapterTxHash: adapter.txHash,
    verifierTxHash: direct.txHash,
  };
}

async function deployContext() {
  const harness = await ethers.deployContract("ZkVerifierGasHarness");
  await harness.waitForDeployment();
  const sp1Verifier = await ethers.deployContract("MockSP1Verifier");
  await sp1Verifier.waitForDeployment();
  const risc0Verifier = await ethers.deployContract("MockRiscZeroVerifier");
  await risc0Verifier.waitForDeployment();
  const pairingVerifier = await ethers.deployContract("PairingSP1VerifierStub");
  await pairingVerifier.waitForDeployment();
  const sp1Adapter = await ethers.deployContract("ZkProofAdapter", [await sp1Verifier.getAddress(), vkey, 0]);
  await sp1Adapter.waitForDeployment();
  const risc0Adapter = await ethers.deployContract("ZkProofAdapter", [await risc0Verifier.getAddress(), imageId, 1]);
  await risc0Adapter.waitForDeployment();
  const pairingAdapter = await ethers.deployContract("ZkProofAdapter", [await pairingVerifier.getAddress(), vkey, 0]);
  await pairingAdapter.waitForDeployment();
  return { harness, sp1Verifier, risc0Verifier, pairingVerifier, sp1Adapter, risc0Adapter, pairingAdapter };
}

async function main() {
  const proofSizes = getArg("proof-sizes-bytes", "256,1024,4096,16384")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const outPath = getArg(
    "out",
    path.join(__dirname, "..", "..", "benchmark-results", "rq3", "zk-verifier-gas.json"),
  );
  if (proofSizes.length === 0) throw new Error("No valid PROOF_SIZES_BYTES supplied");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const ctx = await deployContext();
  const rows: Row[] = [];
  for (const proofSize of proofSizes) {
    console.log(`[RQ3-zk] proof=${proofSize}B backend=sp1-mock`);
    rows.push(await measureSp1Mock(ctx, proofSize, proofSize));
    console.log(`[RQ3-zk] proof=${proofSize}B backend=risc0-mock`);
    rows.push(await measureRisc0Mock(ctx, proofSize, proofSize + 10));
    console.log(`[RQ3-zk] proof=${proofSize}B backend=sp1-bn254-4pair-stub`);
    rows.push(await measurePairingStub(ctx, proofSize, proofSize + 20));
  }

  const net = await ethers.provider.getNetwork();
  const result = {
    schemaVersion: 2,
    rq: "RQ3-zk-verifier",
    mode: "zk-proof-adapter-verifier-gas-latency",
    methodology:
      "Transaction-receipt benchmark for ZkProofAdapter. Mock rows measure adapter binding overhead; the BN254 row exercises a four-pairing precompile stub compatible with the SP1 verifier interface. Receipt latency is wall-clock time from transaction submission to receipt. It excludes zkVM proof generation.",
    generatedAt: new Date().toISOString(),
    network: network.name,
    chainId: Number(net.chainId),
    rpcUrl: (network.config as { url?: string }).url ?? null,
    proofSizes,
    rows,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[RQ3-zk] wrote ${outPath}`);
  console.table(rows.map((row) => ({
    backend: row.backend,
    proofBytes: row.proofBytes,
    adapterProofBytes: row.adapterProofBytes,
    adapterGas: row.adapterVerifyGas,
    verifierGas: row.verifierDirectGas,
    adapterLatencyMs: row.adapterVerifyLatencyMs,
    verifierLatencyMs: row.verifierDirectLatencyMs,
  })));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
