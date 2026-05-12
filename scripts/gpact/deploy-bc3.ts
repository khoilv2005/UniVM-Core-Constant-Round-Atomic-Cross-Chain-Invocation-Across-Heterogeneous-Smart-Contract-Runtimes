/**
 * Deploy GPACT contracts to bc3 (train/taxi chain).
 *
 * Run:
 *   npx hardhat --config hardhat.gpact-bc3.config.ts \
 *               --network besu run scripts/gpact/deploy-bc3.ts
 *
 * Deploys:
 *   GPACTEventSignerRegistry, GPACTCrosschainControl, GPACTTrain, GPACTTaxi
 *
 * Also registers the default GPACT signers and sets quorum idempotently.
 */
import {
  banner, loadDeployment, deployIfMissing, summary, networkName,
  chainIdOf, CONSTS, addressOf, fundActors, PRIVATE_KEYS, writeDeployment,
  readContract, sendContract,
} from "../common";

const GPACT_SIGNER_PRIVATE_KEYS = [
  PRIVATE_KEYS.atomServer,
  PRIVATE_KEYS.judges[1],
  PRIVATE_KEYS.judges[2],
];

async function configureRegistry(registryAddress: string): Promise<string[]> {
  const signerAddresses = GPACT_SIGNER_PRIVATE_KEYS.map(addressOf);

  for (const signer of signerAddresses) {
    const active = await readContract(
      "GPACTEventSignerRegistry",
      registryAddress,
      "activeSigners",
      [signer],
    );
    if (active) {
      console.log(`  [skip] signer ${signer} already active`);
      continue;
    }
    console.log(`  [register] signer ${signer}`);
    await sendContract("GPACTEventSignerRegistry", registryAddress, "registerSigner", [signer]);
  }

  const currentQuorum = BigInt(
    await readContract("GPACTEventSignerRegistry", registryAddress, "quorum"),
  );
  if (currentQuorum !== BigInt(CONSTS.GPACT_SIGNER_QUORUM)) {
    console.log(`  [config] quorum ${currentQuorum} -> ${CONSTS.GPACT_SIGNER_QUORUM}`);
    await sendContract(
      "GPACTEventSignerRegistry",
      registryAddress,
      "setQuorum",
      [CONSTS.GPACT_SIGNER_QUORUM],
    );
  } else {
    console.log(`  [skip] quorum already ${currentQuorum}`);
  }

  return signerAddresses;
}

async function main() {
  const net = networkName();
  banner("gpact", net);
  const rec = loadDeployment("gpact", net);
  rec.chainId = chainIdOf(net);

  const relayerAddr = addressOf(PRIVATE_KEYS.atomServer);
  await fundActors([relayerAddr]);

  const registry = await deployIfMissing(
    rec,
    "gpactSignerRegistry",
    "GPACTEventSignerRegistry",
    [CONSTS.GPACT_SIGNER_QUORUM],
  );

  const control = await deployIfMissing(
    rec,
    "gpactCrosschainControl",
    "GPACTCrosschainControl",
    [chainIdOf(net), registry],
  );

  await deployIfMissing(
    rec,
    "gpactTrain",
    "GPACTTrain",
    [CONSTS.TRAIN_PRICE, CONSTS.TRAIN_SEATS, control],
  );

  await deployIfMissing(
    rec,
    "gpactTaxi",
    "GPACTTaxi",
    [CONSTS.TAXI_PRICE, CONSTS.TAXI_CARS, control],
  );

  const signerAddresses = await configureRegistry(registry);

  const controlOwner = await readContract("GPACTCrosschainControl", control, "owner", []);
  if (String(controlOwner).toLowerCase() !== relayerAddr.toLowerCase()) {
    console.log(`  [config] transfer control ownership -> ${relayerAddr}`);
    await sendContract("GPACTCrosschainControl", control, "transferOwnership", [relayerAddr]);
  } else {
    console.log(`  [skip] control ownership already ${relayerAddr}`);
  }

  rec.contracts.gpactRelayer = relayerAddr;
  rec.contracts.gpactSigners = signerAddresses.join(",");
  rec.contracts.gpactQuorum = String(CONSTS.GPACT_SIGNER_QUORUM);

  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
