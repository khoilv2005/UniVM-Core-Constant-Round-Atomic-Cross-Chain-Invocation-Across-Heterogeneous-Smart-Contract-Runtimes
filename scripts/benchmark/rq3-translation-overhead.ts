/**
 * RQ3d translation-overhead benchmark.
 *
 * Measures code-size and gas overhead for direct Solidity logic versus
 * translated-style EVM clones as contract complexity grows.
 *
 * Usage:
 *   $env:RUNS="5"
 *   $env:LEVELS="4,8,16,32"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-translation-overhead.ts --network hardhat
 */
import { ethers, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Variant = "handwritten" | "translated_naive" | "translated_optimized";

type Sample = {
  run: number;
  variant: Variant;
  contractName: string;
  complexitySlots: number;
  rounds: number;
  deploymentGas: number;
  executionGas: number;
  creationBytecodeBytes: number;
  runtimeBytecodeBytes: number;
  checksum: string;
  blockGasLimit: number;
  executionGasToBlockLimit: number;
};

type Summary = {
  variant: Variant;
  contractName: string;
  complexitySlots: number;
  rounds: number;
  runs: number;
  avgDeploymentGas: number;
  avgExecutionGas: number;
  minExecutionGas: number;
  maxExecutionGas: number;
  stdExecutionGas: number;
  creationBytecodeBytes: number;
  runtimeBytecodeBytes: number;
  avgExecutionGasToBlockLimit: number;
};

const VARIANTS: Array<{ variant: Variant; contractName: string }> = [
  { variant: "handwritten", contractName: "RQ3DHandwritten" },
  { variant: "translated_naive", contractName: "RQ3DTranslatedNaive" },
  { variant: "translated_optimized", contractName: "RQ3DTranslatedOptimized" },
];

function getArg(name: string, fallback: string): string {
  const envName = name.toUpperCase().replace(/-/g, "_");
  const env = process.env[envName];
  if (env && env.trim() !== "") return env.trim();
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = avg(values);
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
}

function byteLength(hex: string): number {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return clean.length / 2;
}

function summarize(samples: Sample[]): Summary[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.variant}:${sample.complexitySlots}:${sample.rounds}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  return [...groups.values()]
    .map((items) => {
      const first = items[0];
      const executionGas = items.map((item) => item.executionGas);
      return {
        variant: first.variant,
        contractName: first.contractName,
        complexitySlots: first.complexitySlots,
        rounds: first.rounds,
        runs: items.length,
        avgDeploymentGas: avg(items.map((item) => item.deploymentGas)),
        avgExecutionGas: avg(executionGas),
        minExecutionGas: Math.min(...executionGas),
        maxExecutionGas: Math.max(...executionGas),
        stdExecutionGas: std(executionGas),
        creationBytecodeBytes: first.creationBytecodeBytes,
        runtimeBytecodeBytes: first.runtimeBytecodeBytes,
        avgExecutionGasToBlockLimit: avg(items.map((item) => item.executionGasToBlockLimit)),
      };
    })
    .sort((a, b) => a.complexitySlots - b.complexitySlots || a.variant.localeCompare(b.variant));
}

function overhead(summary: Summary[]) {
  const byLevel = new Map<number, Summary[]>();
  for (const row of summary) {
    byLevel.set(row.complexitySlots, [...(byLevel.get(row.complexitySlots) ?? []), row]);
  }

  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([complexitySlots, rows]) => {
      const hand = rows.find((row) => row.variant === "handwritten");
      const naive = rows.find((row) => row.variant === "translated_naive");
      const optimized = rows.find((row) => row.variant === "translated_optimized");
      if (!hand || !naive || !optimized) {
        throw new Error(`Missing summary rows for complexity=${complexitySlots}`);
      }
      return {
        complexitySlots,
        naiveExecutionGasOverHandwritten: naive.avgExecutionGas / hand.avgExecutionGas,
        optimizedExecutionGasOverHandwritten: optimized.avgExecutionGas / hand.avgExecutionGas,
        optimizedExecutionGasReductionVsNaive:
          (naive.avgExecutionGas - optimized.avgExecutionGas) / naive.avgExecutionGas,
        naiveRuntimeBytecodeOverHandwritten: naive.runtimeBytecodeBytes / hand.runtimeBytecodeBytes,
        optimizedRuntimeBytecodeOverHandwritten: optimized.runtimeBytecodeBytes / hand.runtimeBytecodeBytes,
      };
    });
}

async function deployAndMeasure(
  run: number,
  variant: Variant,
  contractName: string,
  complexitySlots: number,
  rounds: number,
  blockGasLimit: number,
): Promise<Sample> {
  const artifact = await artifacts.readArtifact(contractName);
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy(complexitySlots);
  const deploymentReceipt = await contract.deploymentTransaction()?.wait();
  if (!deploymentReceipt) {
    throw new Error(`Missing deployment receipt for ${contractName}`);
  }

  const input = 1000 + run + complexitySlots;
  let executionTx;
  if (variant === "translated_naive") {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [input, rounds]);
    executionTx = await (contract as any).execute(encoded);
  } else {
    executionTx = await (contract as any).execute(input, rounds);
  }
  const executionReceipt = await executionTx.wait();
  const checksum = await (contract as any).checksum();
  const runtimeCode = await ethers.provider.getCode(await contract.getAddress());

  return {
    run,
    variant,
    contractName,
    complexitySlots,
    rounds,
    deploymentGas: Number(deploymentReceipt.gasUsed),
    executionGas: Number(executionReceipt.gasUsed),
    creationBytecodeBytes: byteLength(artifact.bytecode),
    runtimeBytecodeBytes: byteLength(runtimeCode),
    checksum: checksum.toString(),
    blockGasLimit,
    executionGasToBlockLimit: Number(executionReceipt.gasUsed) / blockGasLimit,
  };
}

async function main() {
  const runs = Number(getArg("runs", "5"));
  const rounds = Number(getArg("rounds", "1"));
  const levels = getArg("levels", "4,8,16,32")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const outPath = getArg(
    "out",
    path.join(__dirname, "..", "..", "benchmark-results", "rq3", "translation-overhead.json"),
  );

  if (levels.length === 0) throw new Error("No valid LEVELS supplied");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const latestBlock = await ethers.provider.getBlock("latest");
  const blockGasLimit = Number(latestBlock?.gasLimit ?? 0n);
  const samples: Sample[] = [];

  for (const complexitySlots of levels) {
    for (const { variant, contractName } of VARIANTS) {
      for (let run = 1; run <= runs; run++) {
        console.log(
          `[RQ3d] level=${complexitySlots} variant=${variant} run=${run}/${runs}`,
        );
        samples.push(
          await deployAndMeasure(run, variant, contractName, complexitySlots, rounds, blockGasLimit),
        );
      }
    }
  }

  const summary = summarize(samples);
  const overheadRows = overhead(summary);
  const result = {
    schemaVersion: 1,
    rq: "RQ3d",
    mode: "translation-overhead-vs-complexity",
    methodology:
      "Synthetic safe-subset workload comparing direct Solidity storage, naive canonical-byte translation, and optimized typed-slot translation.",
    generatedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    runs,
    levels,
    rounds,
    blockGasLimit,
    summary,
    overhead: overheadRows,
    samples,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[RQ3d] wrote ${outPath}`);
  for (const row of overheadRows) {
    console.log(
      `[RQ3d] level=${row.complexitySlots} optimizedGasOverHand=${row.optimizedExecutionGasOverHandwritten.toFixed(
        3,
      )} naiveGasOverHand=${row.naiveExecutionGasOverHandwritten.toFixed(3)} optReductionVsNaive=${(
        row.optimizedExecutionGasReductionVsNaive * 100
      ).toFixed(1)}%`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
