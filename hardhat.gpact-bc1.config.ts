import { makeConfig } from "./scripts/hardhat-config-factory";
export default makeConfig({ system: "gpact", chain: "bc1", evmVersion: "paris", viaIR: true });
