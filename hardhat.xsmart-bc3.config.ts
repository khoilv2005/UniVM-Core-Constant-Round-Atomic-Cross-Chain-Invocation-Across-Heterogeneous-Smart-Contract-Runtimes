import { makeConfig } from "./scripts/hardhat-config-factory";

export default makeConfig({
  system: "xsmart",
  chain: "bc3",
  viaIR: true,
  sourcesDir: "./contracts/xsmart/bc1",
});
