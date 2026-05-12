import * as fs from "fs";
import * as path from "path";
import {
  PRIVATE_KEYS,
  chainRuntimeConfig,
  ensureDir,
  manifestsDir,
  loadDeployment,
  relayerConfigDir,
  requireContractAddress,
  toPortablePath,
} from "../common";

type SegmentSpec = {
  segment_id: number;
  chain_id: number;
  contract: string;
  function: string;
  kind: "hotel" | "train" | "flight" | "taxi";
};

function segmentsForDepth(
  depth: number,
  bc2Deployment: ReturnType<typeof loadDeployment>,
  bc3Deployment: ReturnType<typeof loadDeployment>,
): SegmentSpec[] {
  const segments: SegmentSpec[] = [];
  if (depth >= 2) {
    segments.push({
      segment_id: 1,
      chain_id: 2,
      contract: requireContractAddress(bc2Deployment, "gpactHotel"),
      function: "hotel",
      kind: "hotel",
    });
  }
  if (depth >= 3) {
    segments.push({
      segment_id: 2,
      chain_id: 3,
      contract: requireContractAddress(bc3Deployment, "gpactTrain"),
      function: "train",
      kind: "train",
    });
  }
  if (depth >= 4) {
    segments.push({
      segment_id: 3,
      chain_id: 2,
      contract: requireContractAddress(bc2Deployment, "gpactFlight"),
      function: "flight",
      kind: "flight",
    });
  }
  if (depth >= 5) {
    segments.push({
      segment_id: 4,
      chain_id: 3,
      contract: requireContractAddress(bc3Deployment, "gpactTaxi"),
      function: "taxi",
      kind: "taxi",
    });
  }
  return segments;
}

async function main() {
  const bc1Deployment = loadDeployment("gpact", "bc1");
  const bc2Deployment = loadDeployment("gpact", "bc2");
  const bc3Deployment = loadDeployment("gpact", "bc3");
  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");

  ensureDir(relayerConfigDir());
  ensureDir(manifestsDir("gpact"));

  for (const depth of [2, 3, 4, 5]) {
    const manifestPath = path.join(manifestsDir("gpact"), `travel-depth-${depth}.generated.json`);
    const configPath = path.join(relayerConfigDir(), `config-gpact-1b-d${depth}.yaml`);
    const manifest = {
      workflow_id: `gpact-travel-depth-${depth}`,
      root_chain_id: 1,
      segments: segmentsForDepth(depth, bc2Deployment, bc3Deployment),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const yaml = `title: "GPACT Relayer Configuration (RQ1b depth ${depth})"

protocol: "gpact"

relayer:
  id: "gpact-relayer-1b-d${depth}"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"
  checkpoint_file: "var/gpact-1b-d${depth}-ckpt.json"

chains:
  bc1:
    name: "${bc1.name}"
    chain_id: ${bc1.chainId}
    rpc_url: "${bc1.rpcUrl}"
    http_url: "${bc1.httpUrl}"
    gpact_control_address: "${requireContractAddress(bc1Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc1Deployment, "gpactTravelRoot")}"

  bc2:
    name: "${bc2.name}"
    chain_id: ${bc2.chainId}
    rpc_url: "${bc2.rpcUrl}"
    http_url: "${bc2.httpUrl}"
    gpact_control_address: "${requireContractAddress(bc2Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc2Deployment, "gpactHotel")}"

  bc3:
    name: "${bc3.name}"
    chain_id: ${bc3.chainId}
    rpc_url: "${bc3.rpcUrl}"
    http_url: "${bc3.httpUrl}"
    gpact_control_address: "${requireContractAddress(bc3Deployment, "gpactCrosschainControl")}"
    gpact_app_address: "${requireContractAddress(bc3Deployment, "gpactTrain")}"

proof:
  max_retry: 3
  retry_delay_ms: 1000
  confirmation_blocks: 1

relay:
  timeout_seconds: 120
  max_pending: 100

gpact:
  manifest: "${toPortablePath(path.relative(relayerConfigDir(), manifestPath))}"
  event_transfer_mode: "direct-signing"
  execution_mode: "serial"
  signer_private_keys:
${[PRIVATE_KEYS.atomServer, PRIVATE_KEYS.judges[1], PRIVATE_KEYS.judges[2]]
  .map((key) => `    - "${key}"`)
  .join("\n")}
`;
    fs.writeFileSync(configPath, yaml, "utf-8");
    console.log(`Rendered GPACT 1b manifest: ${manifestPath}`);
    console.log(`Rendered GPACT 1b config: ${configPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
