/**
 * Deploy IntegrateX contracts to bc3 (train chain).
 *
 * Run:
 *   npx hardhat --config hardhat.integratex-bc3.config.ts \
 *               --network besu run scripts/integratex/deploy-bc3.ts
 *
 * Deploys (depth 3 → 5):
 *   LightClient, RelayerManager, BridgingContract,
 *   LTrain, STrain, LTaxi, STaxi.
 */
import {
  banner, loadDeployment, deployIfMissing, summary, networkName,
  chainIdOf, CONSTS, addressOf, fundActors, PRIVATE_KEYS, writeDeployment,
  readContract, sendContract,
} from "../common";

async function main() {
  const net = networkName();
  banner("integratex", net);
  const rec = loadDeployment("integratex", net);
  rec.chainId = chainIdOf(net);

  await fundActors([addressOf(PRIVATE_KEYS.relayer)]);

  const lc = await deployIfMissing(rec, "lightClient", "LightClient",
    [chainIdOf(net), CONSTS.LIGHT_CLIENT_FINALITY]);
  const rm = await deployIfMissing(rec, "relayerManager", "RelayerManager",
    [CONSTS.RELAYER_MIN_STAKE, CONSTS.RELAYER_REWARD, CONSTS.RELAYER_PENALTY]);
  const bc = await deployIfMissing(rec, "bridgingContract", "BridgingContract",
    [chainIdOf(net), lc, rm, CONSTS.BRIDGE_TIMEOUT_BLOCKS, CONSTS.CROSS_CHAIN_FEE]);

  // depth 3: Train
  const lt = await deployIfMissing(rec, "lTrain", "LTrain", []);
  const sTrain = await deployIfMissing(rec, "sTrain", "STrain",
    [CONSTS.TRAIN_PRICE, CONSTS.TRAIN_SEATS, lt, bc, CONSTS.LOCK_SIZE]);

  // depth 5: Taxi
  const ltx = await deployIfMissing(rec, "lTaxi", "LTaxi", []);
  const sTaxi = await deployIfMissing(rec, "sTaxi", "STaxi",
    [CONSTS.TAXI_PRICE, CONSTS.TAXI_CARS, ltx, bc, CONSTS.LOCK_SIZE]);

  const relayerAddr = addressOf(PRIVATE_KEYS.relayer);
  const relayerActive = await readContract("RelayerManager", rm, "isRelayerActive", [relayerAddr]);
  if (!relayerActive) {
    console.log(`  [init]   register relayer ${relayerAddr}`);
    await sendContract("RelayerManager", rm, "registerRelayer", [], CONSTS.RELAYER_MIN_STAKE);
  } else {
    console.log(`  [skip]   relayer already active ${relayerAddr}`);
  }

  const configuredBridge = await readContract("RelayerManager", rm, "bridgingContract", []);
  if (String(configuredBridge).toLowerCase() !== bc.toLowerCase()) {
    console.log(`  [init]   set bridging contract ${bc}`);
    await sendContract("RelayerManager", rm, "setBridgingContract", [bc]);
  } else {
    console.log(`  [skip]   bridging contract already set ${bc}`);
  }

  for (const stateContract of [sTrain, sTaxi]) {
    const registered = await readContract("BridgingContract", bc, "registeredStateContracts", [stateContract]);
    if (!registered) {
      console.log(`  [init]   register state ${stateContract}`);
      await sendContract("BridgingContract", bc, "regState", [stateContract]);
    } else {
      console.log(`  [skip]   state already registered ${stateContract}`);
    }
  }

  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
