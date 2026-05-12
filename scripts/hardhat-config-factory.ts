/**
 * Factory để tạo Hardhat config cho mỗi (system, chain) trong contracts/.
 * Dùng từ các file hardhat.<system>-<chain>.config.ts riêng để paths/artifacts
 * tách biệt, tránh giẫm chân.
 */
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const DEPLOYER_PRIVATE_KEY = "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291";

export type System = "xsmart" | "integratex" | "atom" | "gpact";
export type Chain = "bc1" | "bc2" | "bc3";

export interface SystemConfigOpts {
  system: System;
  chain: Chain;
  /** override sources path when a chain reuses another chain's Solidity sources */
  sourcesDir?: string;
  /** override solc version (default 0.8.28) */
  solcVersion?: string;
  /** override evm target (default paris) */
  evmVersion?: string;
  /** enable viaIR for stack-heavy contracts */
  viaIR?: boolean;
  /** override RPC URL env var name */
  rpcEnv?: string;
}

export function makeConfig(opts: SystemConfigOpts): HardhatUserConfig {
  const tag = `${opts.system}-${opts.chain}`;
  const rpcEnv = opts.rpcEnv || `${opts.chain.toUpperCase()}_RPC_URL`;
  return {
    solidity: {
      version: opts.solcVersion || "0.8.28",
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: opts.viaIR ?? false,
        evmVersion: opts.evmVersion || "paris",
      },
    },
    paths: {
      sources: opts.sourcesDir || `./contracts/${opts.system}/${opts.chain}`,
      artifacts: `./artifacts/${tag}`,
      cache: `./cache/${tag}`,
      tests: `./test/${tag}`,
    },
    typechain: {
      outDir: `./typechain/${tag}`,
      target: "ethers-v6",
    },
    networks: {
      hardhat: {
        chainId: 1337,
      },
      local: {
        url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
        chainId: 1337,
        accounts: [DEPLOYER_PRIVATE_KEY],
      },
      besu: {
        url: process.env[rpcEnv] || (
          opts.chain === "bc1" ? "http://209.38.21.129:8545" :
          opts.chain === "bc2" ? "http://170.64.194.4:8545" :
          "http://170.64.164.173:8545"
        ),
        chainId: 1337,
        accounts: [DEPLOYER_PRIVATE_KEY],
      },
    },
  };
}
