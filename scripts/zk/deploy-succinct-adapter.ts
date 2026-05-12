import { banner, loadDeployment, networkName, summary, writeDeployment } from "../common";
import { deploySelectedProofAdapter, setSelectedProofAdapter } from "../xsmart/proof-adapter";

async function main(): Promise<void> {
  const net = networkName();
  banner("xsmart", `${net}:succinct-proof-adapter`);
  const rec = loadDeployment("xsmart", net);
  const bridge = rec.contracts.xBridgingContract || rec.contracts.bridge;
  const lightClient = rec.contracts.lightClient || rec.contracts.LightClient;
  if (!bridge) {
    throw new Error(`Deployment xsmart/${net} missing xBridgingContract`);
  }
  if (!lightClient) {
    throw new Error(`Deployment xsmart/${net} missing lightClient`);
  }

  const adapter = await deploySelectedProofAdapter(rec, lightClient);
  if (adapter.mode !== "succinct_sp1" && adapter.mode !== "succinct_risc0") {
    throw new Error(
      `Set XSMART_PROOF_ADAPTER_MODE=succinct_sp1 or succinct_risc0; got ${adapter.mode}`,
    );
  }
  await setSelectedProofAdapter(bridge, adapter);
  writeDeployment(rec);
  summary(rec);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
