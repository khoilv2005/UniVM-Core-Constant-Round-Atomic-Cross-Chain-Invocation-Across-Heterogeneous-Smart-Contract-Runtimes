/**
 * Deploy ATOM contracts to bc2 (hotel chain).
 *
 * Deploys: AtomHotel (depth 2), AtomFlight (depth 4).
 * NOTE: ATOM service contracts take (price, remain, atomServer). atomServer
 * is the ATOM server/broker principal used by invoke-time signatures.
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

  await deployIfMissing(rec, "atomHotel",  "AtomHotel",
    [CONSTS.HOTEL_PRICE,  CONSTS.HOTEL_REMAIN,  serverAddr]);
  await deployIfMissing(rec, "atomFlight", "AtomFlight",
    [CONSTS.FLIGHT_PRICE, CONSTS.FLIGHT_SEATS,  serverAddr]);
  rec.contracts.atomServer = serverAddr;
  writeDeployment(rec);
  summary(rec);
}

main().catch((e) => { console.error(e); process.exit(1); });
