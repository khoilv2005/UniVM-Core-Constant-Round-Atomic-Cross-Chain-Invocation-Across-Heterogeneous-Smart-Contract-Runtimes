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

async function main() {
  const bc1Deployment = loadDeployment("gpact", "bc1");
  const bc2Deployment = loadDeployment("gpact", "bc2");
  const bc3Deployment = loadDeployment("gpact", "bc3");

  const bc1 = chainRuntimeConfig("bc1");
  const bc2 = chainRuntimeConfig("bc2");
  const bc3 = chainRuntimeConfig("bc3");

  const manifestPath = path.join(manifestsDir("gpact"), "train-hotel-write.generated.json");
  ensureDir(relayerConfigDir());
  const configPath = path.join(relayerConfigDir(), "config-gpact.yaml");

  const yaml = `title: "GPACT Relayer Configuration"

protocol: "gpact"

relayer:
  id: "gpact-relayer"
  log_level: "debug"
  workers: 4
  private_key: "${PRIVATE_KEYS.atomServer}"

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
  timeout_seconds: 60
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
  console.log(`Rendered GPACT relayer config: ${configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
