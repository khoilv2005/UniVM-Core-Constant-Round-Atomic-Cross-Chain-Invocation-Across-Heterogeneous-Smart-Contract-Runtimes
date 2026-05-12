import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { ethers } from "ethers";
import { ApiPromise, WsProvider } from "@polkadot/api";

type AdapterRow = {
  adapterPath: string;
  evidence: string;
  evidenceSizeBytes: number | null;
  extractionMs: number | null;
  verificationMs: number | null;
  verificationPlacement: "on-chain" | "component/off-chain" | "not-run";
  status: "implemented" | "prototype" | "unavailable";
  includedInRq1c: boolean;
  note: string;
};

const root = path.resolve(__dirname, "..", "..");
const outPath = path.join(root, "benchmark-results", "adapter-overhead.json");

function arg(name: string, fallback: string) {
  const env = process.env[name.toUpperCase().replace(/-/g, "_")];
  if (env && env.trim() !== "") return env.trim();
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function nowNs() {
  return process.hrtime.bigint();
}

function elapsedMs(startNs: bigint) {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}

function jsonSizeBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function sha256Hex(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function measureEvm(): Promise<AdapterRow> {
  const rpcUrl = arg("evm-rpc-url", "http://209.38.21.129:8545");
  const deploymentFile = path.join(root, "deployments", "xsmart", "bc1.json");
  const deployment = fs.existsSync(deploymentFile) ? readJson(deploymentFile) : { contracts: {} };
  const proofAddress = arg("evm-proof-address", deployment.contracts?.xBridgingContract ?? ethers.ZeroAddress);
  const txHashOverride = arg("evm-tx-hash", "");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const started = nowNs();
    let receipt: any = null;
    if (txHashOverride !== "") {
      receipt = await provider.getTransactionReceipt(txHashOverride);
    } else {
      const block = await provider.getBlock("latest", true);
      const txs = (block?.transactions ?? []) as any[];
      const hash = txs.length > 0 ? (typeof txs[0] === "string" ? txs[0] : txs[0].hash) : "";
      if (hash !== "") receipt = await provider.getTransactionReceipt(hash);
    }
    const proof = await provider.send("eth_getProof", [proofAddress, [], "latest"]).catch((error: unknown) => ({
      unavailable: error instanceof Error ? error.message : String(error),
    }));
    const extractionMs = elapsedMs(started);
    const evidence = { receipt, proof };
    const proofAvailable = proof !== null && typeof proof === "object" && !("unavailable" in proof);
    const verificationStarted = nowNs();
    const receiptHash = receipt ? sha256Hex(Buffer.from(JSON.stringify(receipt))) : null;
    const proofHash = proof ? sha256Hex(Buffer.from(JSON.stringify(proof))) : null;
    const verificationMs = elapsedMs(verificationStarted);
    return {
      adapterPath: "EVM/Besu receipt-storage",
      evidence: "finalized receipt plus optional eth_getProof storage evidence",
      evidenceSizeBytes: jsonSizeBytes(evidence),
      extractionMs,
      verificationMs,
      verificationPlacement: "on-chain",
      status: receipt || proofAvailable ? "implemented" : "unavailable",
      includedInRq1c: true,
      note: receipt
        ? `component hash check receipt=${receiptHash} proof=${proofHash}; on-chain gas is measured by the bridge verifier path, not this off-chain probe`
        : proofAvailable
          ? `storage proof available without receipt sample; proof=${proofHash}; set EVM_TX_HASH for a receipt-specific evidence sample`
          : "no transaction receipt found at latest block and eth_getProof was unavailable; set EVM_TX_HASH for a specific evidence sample",
    };
  } catch (error) {
    return {
      adapterPath: "EVM/Besu receipt-storage",
      evidence: "finalized receipt plus optional eth_getProof storage evidence",
      evidenceSizeBytes: null,
      extractionMs: null,
      verificationMs: null,
      verificationPlacement: "not-run",
      status: "unavailable",
      includedInRq1c: true,
      note: error instanceof Error ? error.message : String(error),
    };
  } finally {
    provider.destroy();
  }
}

async function measureWasm(): Promise<AdapterRow> {
  const deploymentFile = path.join(root, "deployments", "xsmart", "bc2.json");
  const deployment = fs.existsSync(deploymentFile) ? readJson(deploymentFile) : { contracts: {} };
  const wsUrl = arg("wasm-ws-url", deployment.contracts?.bc2RpcWs ?? "ws://170.64.194.4:18545");
  const contractAddress = arg("wasm-contract", deployment.contracts?.trainBooking ?? "");
  let api: ApiPromise | undefined;
  try {
    const provider = new WsProvider(wsUrl);
    api = await ApiPromise.create({ provider });
    const extractionStarted = nowNs();
    const finalizedHead = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(finalizedHead);
    const accountKey = api.query.system.account.key(contractAddress);
    const proof = await api.rpc.state.getReadProof([accountKey], finalizedHead);
    const extractionMs = elapsedMs(extractionStarted);
    const evidence = {
      finalizedHead: finalizedHead.toString(),
      blockNumber: header.number.toString(),
      contractAddress,
      storageKey: accountKey.toString(),
      proof: proof.toJSON(),
    };
    const verificationStarted = nowNs();
    const bindingHash = sha256Hex(Buffer.from(JSON.stringify(evidence)));
    const verificationMs = elapsedMs(verificationStarted);
    return {
      adapterPath: "WASM/Substrate storage-event",
      evidence: "finalized header hash and state read proof for the contract account",
      evidenceSizeBytes: jsonSizeBytes(evidence),
      extractionMs,
      verificationMs,
      verificationPlacement: "component/off-chain",
      status: "prototype",
      includedInRq1c: false,
      note: `component binding hash=${bindingHash}; not a deployed GRANDPA/light-client verifier`,
    };
  } catch (error) {
    return {
      adapterPath: "WASM/Substrate storage-event",
      evidence: "finalized header hash and state read proof for the contract account",
      evidenceSizeBytes: null,
      extractionMs: null,
      verificationMs: null,
      verificationPlacement: "not-run",
      status: "unavailable",
      includedInRq1c: false,
      note: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await api?.disconnect();
  }
}

function measureFabric(): AdapterRow {
  const deploymentFile = path.join(root, "deployments", "xsmart", "bc3.json");
  const deployment = fs.existsSync(deploymentFile) ? readJson(deploymentFile) : { contracts: {} };
  const contracts = deployment.contracts ?? {};
  const relayerExe = path.join(root, "relayer", process.platform === "win32" ? "relayer.exe" : "relayer");
  const relayerConfig = path.join(root, "configs", "relayer", "config-xsmart.yaml");
  const endpoint = arg("fabric-endpoint", contracts.hotelBooking ?? "HotelBooking");
  const method = arg("fabric-method", "GetPrice");
  try {
    const cert = fs.existsSync(contracts.bc3FabricUserCertPath ?? "")
      ? fs.readFileSync(contracts.bc3FabricUserCertPath)
      : Buffer.alloc(0);
    const tls = fs.existsSync(contracts.bc3FabricTLSCertPath ?? "")
      ? fs.readFileSync(contracts.bc3FabricTLSCertPath)
      : Buffer.alloc(0);
    const extractionStarted = nowNs();
    let evaluate: unknown = { skipped: "relayer binary or Fabric endpoint unavailable" };
    if (fs.existsSync(relayerExe) && fs.existsSync(relayerConfig)) {
      const raw = execFileSync(
        relayerExe,
        ["fabric-evaluate", "--config", relayerConfig, "--chain", "bc3", "--endpoint", endpoint, "--method", method],
        { cwd: root, encoding: "utf8", timeout: Number(arg("fabric-timeout-ms", "60000")) },
      );
      evaluate = JSON.parse(raw);
    }
    const extractionMs = elapsedMs(extractionStarted);
    const evidence = {
      channel: contracts.bc3FabricChannel,
      chaincode: contracts.bc3FabricChaincode,
      endpoint,
      method,
      mspid: contracts.bc3FabricMSPID,
      peer: contracts.bc3FabricPeerName,
      userCertSha256: cert.length ? sha256Hex(cert) : null,
      tlsCertSha256: tls.length ? sha256Hex(tls) : null,
      evaluate,
    };
    const verificationStarted = nowNs();
    const requiredFieldsPresent = Boolean(evidence.channel && evidence.chaincode && evidence.mspid && evidence.peer);
    const policyBindingHash = sha256Hex(Buffer.from(JSON.stringify({
      channel: evidence.channel,
      chaincode: evidence.chaincode,
      mspid: evidence.mspid,
      userCertSha256: evidence.userCertSha256,
      tlsCertSha256: evidence.tlsCertSha256,
    })));
    const verificationMs = elapsedMs(verificationStarted);
    return {
      adapterPath: "Fabric endorsement-block evidence",
      evidence: "channel/chaincode binding, admin certificate hashes, and evaluate response",
      evidenceSizeBytes: jsonSizeBytes(evidence),
      extractionMs,
      verificationMs,
      verificationPlacement: "component/off-chain",
      status: requiredFieldsPresent ? "prototype" : "unavailable",
      includedInRq1c: false,
      note: `component policy binding hash=${policyBindingHash}; this does not include full block-inclusion verification`,
    };
  } catch (error) {
    return {
      adapterPath: "Fabric endorsement-block evidence",
      evidence: "channel/chaincode binding, admin certificate hashes, and evaluate response",
      evidenceSizeBytes: null,
      extractionMs: null,
      verificationMs: null,
      verificationPlacement: "not-run",
      status: "unavailable",
      includedInRq1c: false,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const provenance = {
    testbed: "real VM endpoints",
    evmRpcUrl: arg("evm-rpc-url", "http://209.38.21.129:8545"),
    evmTxHash: arg("evm-tx-hash", ""),
    wasmWsUrl: arg("wasm-ws-url", "ws://170.64.194.4:18545"),
    fabricEndpoint: arg("fabric-endpoint", "HotelBooking"),
    fabricMethod: arg("fabric-method", "GetPrice"),
    command:
      "npx ts-node --project tsconfig.scripts.json scripts/benchmark/adapter-overhead.ts",
  };
  const rows: AdapterRow[] = [];
  rows.push(await measureEvm());
  rows.push(await measureWasm());
  rows.push(measureFabric());
  const result = {
    schemaVersion: 1,
    rq: "RQ4",
    generatedAt,
    provenance,
    methodology:
      "Component-level adapter-cost probe. EVM evidence is the implemented bridge path; WASM/Fabric rows are off-chain/component checks and are not included in RQ1c trusted-adapter latency.",
    rows,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Saved adapter overhead results to ${outPath}`);
  console.table(rows.map((row) => ({
    adapterPath: row.adapterPath,
    evidenceKB: row.evidenceSizeBytes === null ? "N/A" : (row.evidenceSizeBytes / 1024).toFixed(2),
    extractionMs: row.extractionMs === null ? "N/A" : row.extractionMs.toFixed(2),
    verificationMs: row.verificationMs === null ? "N/A" : row.verificationMs.toFixed(2),
    placement: row.verificationPlacement,
    status: row.status,
    includedInRq1c: row.includedInRq1c,
  })));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
