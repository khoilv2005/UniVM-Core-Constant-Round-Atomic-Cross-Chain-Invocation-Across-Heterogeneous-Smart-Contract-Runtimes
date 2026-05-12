/**
 * Deploy IntegrateX contracts to bc1 (execution chain).
 *
 * Run:
 *   npx hardhat --config hardhat.integratex-bc1.config.ts \
 *               --network besu run scripts/integratex/deploy-bc1.ts
 *
 * Deploys: LightClient, RelayerManager, BridgingContract, CrossChainTravelDApp.
 * The bc1 build also pulls in LHotel + LTrain pure-logic contracts so that
 * CrossChainTravelDApp can compute totals locally.
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

  // 1. LightClient
  const lc = await deployIfMissing(rec, "lightClient", "LightClient",
    [chainIdOf(net), CONSTS.LIGHT_CLIENT_FINALITY]);

  // 2. RelayerManager
  const rm = await deployIfMissing(rec, "relayerManager", "RelayerManager",
    [CONSTS.RELAYER_MIN_STAKE, CONSTS.RELAYER_REWARD, CONSTS.RELAYER_PENALTY]);

  // 3. BridgingContract
  const bc = await deployIfMissing(rec, "bridgingContract", "BridgingContract",
    [chainIdOf(net), lc, rm, CONSTS.BRIDGE_TIMEOUT_BLOCKS, CONSTS.CROSS_CHAIN_FEE]);

  // 4. LHotel + LTrain (pure-logic, used by CrossChainTravelDApp)
  const lh = await deployIfMissing(rec, "lHotel", "LHotel", []);
  const lt = await deployIfMissing(rec, "lTrain", "LTrain", []);
  const lf = await deployIfMissing(rec, "lFlight", "LFlight", []);
  const ltx = await deployIfMissing(rec, "lTaxi", "LTaxi", []);

  // 5. CrossChainTravelDApp
  await deployIfMissing(rec, "travelDApp", "CrossChainTravelDApp",
    [bc, lh, lt, CONSTS.DAPP_TIMEOUT_BLOCKS]);
  await deployIfMissing(rec, "travelDepthDApp", "CrossChainTravelDepthDApp",
    [bc, lh, lt, lf, ltx, CONSTS.DAPP_TIMEOUT_BLOCKS]);

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

  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
