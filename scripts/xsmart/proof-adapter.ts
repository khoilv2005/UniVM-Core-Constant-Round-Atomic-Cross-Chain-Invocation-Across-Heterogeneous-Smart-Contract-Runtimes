import {
  DeploymentRecord,
  deployIfMissing,
  readContract,
  sendContract,
} from "../common";

export type ProofAdapterMode =
  "component_verified" |
  "zk_substrate" |
  "zk_fabric" |
  "zk_both" |
  "succinct_sp1" |
  "succinct_risc0" |
  "production_proof";

export function proofAdapterMode(): ProofAdapterMode {
  const raw = (process.env.XSMART_PROOF_ADAPTER_MODE || process.env.XSMART_PROOF_MODE || "component_verified")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "zk_substrate" || raw === "substrate_proof" || raw === "proof_backed_substrate") {
    return "zk_substrate";
  }
  if (raw === "zk_fabric" || raw === "fabric_proof" || raw === "proof_backed_fabric") {
    return "zk_fabric";
  }
  if (raw === "zk_both" || raw === "both" || raw === "proof_backed_both" || raw === "both_proof") {
    return "zk_both";
  }
  if (raw === "sp1" || raw === "succinct_sp1" || raw === "zk_sp1") {
    return "succinct_sp1";
  }
  if (raw === "risc0" || raw === "risc_zero" || raw === "succinct_risc0" || raw === "zk_risc0") {
    return "succinct_risc0";
  }
  if (raw === "production_proof" || raw === "production" || raw === "trust_minimized_production") {
    return "production_proof";
  }
  if (raw === "component" || raw === "component_verified" || raw === "verified_adapter") {
    return "component_verified";
  }
  throw new Error(`Unsupported XSmart proof adapter mode: ${raw}`);
}

export async function deploySelectedProofAdapter(
  rec: DeploymentRecord,
  lightClient: string,
): Promise<{ mode: ProofAdapterMode; address: string }> {
  const mode = proofAdapterMode();
  if (mode === "zk_substrate") {
    const address = await deployIfMissing(rec, "substrateStateProofAdapter", "SubstrateStateProofAdapter", [
      lightClient,
    ]);
    return { mode, address };
  }
  if (mode === "zk_fabric") {
    const address = await deployIfMissing(rec, "fabricStateProofAdapter", "FabricStateProofAdapter", [
      lightClient,
    ]);
    return { mode, address };
  }
  if (mode === "zk_both") {
    const component = await deployIfMissing(rec, "componentVerifiedAdapter", "ComponentVerifiedAdapter", [
      lightClient,
    ]);
    const substrate = await deployIfMissing(rec, "substrateStateProofAdapter", "SubstrateStateProofAdapter", [
      lightClient,
    ]);
    const fabric = await deployIfMissing(rec, "fabricStateProofAdapter", "FabricStateProofAdapter", [
      lightClient,
    ]);
    const address = await deployIfMissing(rec, "compositeProofAdapter", "CompositeProofAdapter", [
      component,
      substrate,
      fabric,
    ]);
    return { mode, address };
  }
  if (mode === "succinct_sp1") {
    const verifier = requiredEnv("XSMART_SP1_VERIFIER_ADDRESS");
    const programVKey = requiredBytes32Env("XSMART_SP1_PROGRAM_VKEY");
    const address = await deployIfMissing(rec, "sp1ZkProofAdapter", "ZkProofAdapter", [
      verifier,
      programVKey,
      0,
    ]);
    return { mode, address };
  }
  if (mode === "succinct_risc0") {
    const verifier = requiredEnv("XSMART_RISC0_VERIFIER_ADDRESS");
    const imageId = requiredBytes32Env("XSMART_RISC0_IMAGE_ID");
    const address = await deployIfMissing(rec, "risc0ZkProofAdapter", "ZkProofAdapter", [
      verifier,
      imageId,
      1,
    ]);
    return { mode, address };
  }
  if (mode === "production_proof") {
    const address = (process.env.XSMART_PRODUCTION_PROOF_ADAPTER_ADDRESS || "").trim();
    if (!address) {
      throw new Error(
        "production_proof mode requires XSMART_PRODUCTION_PROOF_ADAPTER_ADDRESS; " +
        "the current MVP adapters must not be used as production GRANDPA/Fabric MSP/light-client verifiers.",
      );
    }
    return { mode, address };
  }

  const address = await deployIfMissing(rec, "componentVerifiedAdapter", "ComponentVerifiedAdapter", [
    lightClient,
  ]);
  return { mode, address };
}

function requiredEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required for succinct ZK proof adapter deployment`);
  }
  return value;
}

function requiredBytes32Env(name: string): string {
  const value = requiredEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed bytes32 value`);
  }
  return value;
}

export async function setSelectedProofAdapter(
  bridge: string,
  adapter: { mode: ProofAdapterMode; address: string },
): Promise<void> {
  let currentProofAdapter: string;
  try {
    currentProofAdapter = await readContract("XBridgingContract", bridge, "proofAdapter", []);
  } catch (error) {
    throw new Error(
      `XBridgingContract at ${bridge} does not expose proofAdapter(); redeploy bc1 with the current contracts before running proof-backed RQ1c. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (String(currentProofAdapter).toLowerCase() !== adapter.address.toLowerCase()) {
    console.log(`  [init]   set proof adapter ${adapter.address} (${adapter.mode})`);
    await sendContract("XBridgingContract", bridge, "setProofAdapter", [adapter.address]);
  } else {
    console.log(`  [skip]   proof adapter already set ${adapter.address} (${adapter.mode})`);
  }
}
