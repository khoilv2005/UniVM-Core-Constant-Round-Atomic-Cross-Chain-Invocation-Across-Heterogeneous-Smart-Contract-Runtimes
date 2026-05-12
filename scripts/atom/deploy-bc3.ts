/**
 * Deploy ATOM contracts to bc3 (train chain).
 *
 * Deploys: AtomTrain (depth 3), AtomTaxi (depth 5).
 */
import {
  banner, loadDeployment, deployIfMissing, summary, networkName,
  chainIdOf, CONSTS, addressOf, fundActors, PRIVATE_KEYS, writeDeployment,
} from "../common";

async function main() {
  const net = networkName();
  banner("atom", net);
  const rec = loadDeployment("atom", net);
  rec.chainId = chainIdOf(net);

  const serverAddr = addressOf(PRIVATE_KEYS.atomServer);
  await fundActors([serverAddr]);

  await deployIfMissing(rec, "atomTrain", "AtomTrain",
    [CONSTS.TRAIN_PRICE, CONSTS.TRAIN_SEATS, serverAddr]);
  await deployIfMissing(rec, "atomTaxi",  "AtomTaxi",
    [CONSTS.TAXI_PRICE,  CONSTS.TAXI_CARS,  serverAddr]);
  rec.contracts.atomServer = serverAddr;
  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
