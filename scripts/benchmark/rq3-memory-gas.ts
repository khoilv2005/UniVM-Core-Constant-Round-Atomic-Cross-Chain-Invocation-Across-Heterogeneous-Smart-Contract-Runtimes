/**
 * RQ3d linear-memory gas microbenchmark.
 *
 * Measures calldata decode, linear scan execution, and trie-backed storage
 * emulation costs for canonical byte payloads from 1 KiB to 64 KiB.
 *
 * Usage:
 *   $env:RUNS="3"
 *   $env:SIZES_KB="1,2,4,8,16,32,64"
 *   npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-memory-gas.ts --network hardhat
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Method = "decode" | "execute" | "total";

type Sample = {
  run: number;
  sizeBytes: number;
  sizeKiB: number;
  method: Method;
  success: boolean;
  gasUsed: number | null;
  latencyMs: number;
  blockGasLimit: number;
  gasToBlockLimit: number | null;
  error?: string;
};

type Summary = {
  sizeBytes: number;
  sizeKiB: number;
  method: Method;
  runs: number;
  successes: number;
  avgGas: number | null;
  minGas: number | null;
  maxGas: number | null;
  stdGas: number | null;
  avgLatencyMs: number;
  avgGasToBlockLimit: number | null;
};

const METHODS: Method[] = ["decode", "execute", "total"];

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

function payload(sizeBytes: number, seed: number): string {
  const bytes = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    bytes[i] = (i * 31 + seed * 17 + 13) & 0xff;
  }
  return ethers.hexlify(bytes);
}

function summarize(samples: Sample[]): Summary[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.method}:${sample.sizeBytes}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  return [...groups.values()]
    .map((items) => {
      const first = items[0];
      const gas = items
        .filter((item) => item.success && item.gasUsed !== null)
        .map((item) => item.gasUsed as number);
      const gasToLimit = items
        .filter((item) => item.success && item.gasToBlockLimit !== null)
        .map((item) => item.gasToBlockLimit as number);
      return {
        sizeBytes: first.sizeBytes,
        sizeKiB: first.sizeKiB,
        method: first.method,
        runs: items.length,
        successes: gas.length,
        avgGas: gas.length ? avg(gas) : null,
        minGas: gas.length ? Math.min(...gas) : null,
        maxGas: gas.length ? Math.max(...gas) : null,
        stdGas: gas.length ? std(gas) : null,
        avgLatencyMs: avg(items.map((item) => item.latencyMs)),
        avgGasToBlockLimit: gasToLimit.length ? avg(gasToLimit) : null,
      };
    })
    .sort((a, b) => a.sizeBytes - b.sizeBytes || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
}

function fitThreshold(summary: Summary[], gasThreshold: number) {
  const rows = summary
    .filter((row) => row.method === "total" && row.avgGas !== null)
    .map((row) => ({ x: row.sizeBytes, y: row.avgGas as number }));
  const successful = rows.map((row) => row.x);
  const observedMaxBytes = successful.length ? Math.max(...successful) : 0;
  if (rows.length < 2) {
    return {
      observedMaxBytes,
      fittedMaxBytesAtBlockLimit: null,
      slopeGasPerByte: null,
      interceptGas: null,
    };
  }

  const meanX = avg(rows.map((row) => row.x));
  const meanY = avg(rows.map((row) => row.y));
  const numerator = rows.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0);
  const denominator = rows.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0);
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  const fittedMax = Math.floor((gasThreshold - intercept) / slope);
  return {
    observedMaxBytes,
    fittedMaxBytesAtBlockLimit: fittedMax > 0 ? fittedMax : null,
    slopeGasPerByte: slope,
    interceptGas: intercept,
  };
}

async function measure(run: number, method: Method, sizeBytes: number, blockGasLimit: number): Promise<Sample> {
  const factory = await ethers.getContractFactory("RQ3DMemoryGas");
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const data = payload(sizeBytes, run);
  const started = Date.now();

  try {
    let tx;
    if (method === "decode") {
      tx = await (contract as any).decodeOnly(data);
    } else if (method === "execute") {
      tx = await (contract as any).executeOnly(data, 1);
    } else {
      tx = await (contract as any).importAndExecute(data, 1);
    }
    const receipt = await tx.wait();
    const latencyMs = Date.now() - started;
    const gasUsed = Number(receipt.gasUsed);
    return {
      run,
      sizeBytes,
      sizeKiB: sizeBytes / 1024,
      method,
      success: true,
      gasUsed,
      latencyMs,
      blockGasLimit,
      gasToBlockLimit: gasUsed / blockGasLimit,
    };
  } catch (error) {
    return {
      run,
      sizeBytes,
      sizeKiB: sizeBytes / 1024,
      method,
      success: false,
      gasUsed: null,
      latencyMs: Date.now() - started,
      blockGasLimit,
      gasToBlockLimit: null,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

async function main() {
  const runs = Number(getArg("runs", "3"));
  const gasThreshold = Number(getArg("gas-threshold", "30000000"));
  const sizesKiB = getArg("sizes-kb", "1,2,4,8,16,32,64")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const outPath = getArg(
    "out",
    path.join(__dirname, "..", "..", "benchmark-results", "rq3", "memory-gas.json"),
  );

  if (sizesKiB.length === 0) throw new Error("No valid SIZES_KB supplied");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const latestBlock = await ethers.provider.getBlock("latest");
  const blockGasLimit = Number(latestBlock?.gasLimit ?? 30000000n);
  const samples: Sample[] = [];

  for (const sizeKiB of sizesKiB) {
    const sizeBytes = sizeKiB * 1024;
    for (const method of METHODS) {
      for (let run = 1; run <= runs; run++) {
        console.log(`[RQ3d-memory] size=${sizeKiB}KiB method=${method} run=${run}/${runs}`);
        samples.push(await measure(run, method, sizeBytes, blockGasLimit));
      }
    }
  }

  const summary = summarize(samples);
  const threshold = fitThreshold(summary, gasThreshold);
  const result = {
    schemaVersion: 1,
    rq: "RQ3d-memory",
    mode: "linear-memory-to-evm-storage-gas",
    methodology:
      "Synthetic canonical byte payloads measuring decode-only, scan execution, and trie-backed storage import costs on fresh contracts.",
    generatedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    runs,
    sizesKiB,
    blockGasLimit,
    gasThreshold,
    threshold,
    summary,
    samples,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[RQ3d-memory] wrote ${outPath}`);
  console.log(
    `[RQ3d-memory] observed B_max=${(threshold.observedMaxBytes / 1024).toFixed(1)}KiB fitted B_max=${
      threshold.fittedMaxBytesAtBlockLimit === null
        ? "n/a"
        : `${(threshold.fittedMaxBytesAtBlockLimit / 1024).toFixed(1)}KiB`
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
