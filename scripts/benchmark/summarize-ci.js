const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const resultsDir = path.join(root, "benchmark-results");
const rq3Dir = path.join(resultsDir, "rq3");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, ""));
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values) {
  if (!values.length) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length);
}

function ci95(stdValue, n) {
  if (!n) return 0;
  return 1.96 * stdValue / Math.sqrt(n);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[index];
}

function seconds(valueMs) {
  return valueMs / 1000;
}

function fixed(value, digits = 3) {
  if (!Number.isFinite(value)) return "N/A";
  return value.toFixed(digits);
}

function rq1Rows() {
  const files = [
    ["RQ1a", "IntegrateX", "representative", "benchmark-results/integratex-50.json"],
    ["RQ1a", "AtomCI", "representative", "benchmark-results/atom-write-50.json"],
    ["RQ1a", "GPACT", "representative", "benchmark-results/gpact-50.json"],
    ["RQ1a", "XSmartContract", "representative", "benchmark-results/xsmart-1a.json"],
    ...["d2", "d3", "d4", "d5"].flatMap((depth) => [
      ["RQ1b", "IntegrateX", depth, `benchmark-results/integratex-1b-${depth}.json`],
      ["RQ1b", "AtomCI", depth, `benchmark-results/atom-1b-${depth}.json`],
      ["RQ1b", "GPACT", depth, `benchmark-results/gpact-1b-${depth}.json`],
      ["RQ1b", "XSmartContract", depth, `benchmark-results/xsmart-1b-${depth}.json`],
    ]),
    ["RQ1c", "XSmartContract", "heterogeneous", "benchmark-results/xsmart-prod.json"],
    ["RQ1c", "GPACT", "heterogeneous", "benchmark-results/gpact-prod.json"],
    ["RQ1c", "AtomCI", "heterogeneous", "benchmark-results/atom-prod.json"],
  ];

  return files
    .filter(([, , , rel]) => fs.existsSync(path.join(root, rel)))
    .map(([rq, protocol, setting, rel]) => {
      const json = readJson(rel);
      const samples = json.samples || json.runs || [];
      const values = samples
        .map((sample) => sample.latencyMs ?? (sample.latencySeconds ? sample.latencySeconds * 1000 : undefined))
        .filter((value) => Number.isFinite(value));
      const n = json.summary?.runs ?? values.length;
      const avgMs = json.summary?.avgMs ?? json.summary?.avgLatencyMs ?? mean(values);
      const medianMs = json.summary?.medianMs ?? json.summary?.medianLatencyMs ?? json.summary?.medianCompletionLatencyMs;
      const stdMs = json.summary?.stdMs ?? json.summary?.stdLatencyMs ?? std(values);
      return { rq, protocol, setting, n, meanSeconds: seconds(avgMs), medianSeconds: seconds(medianMs ?? 0), stdSeconds: seconds(stdMs), ciSeconds: seconds(ci95(stdMs, n)), rel };
    });
}

function rq3Rows() {
  if (!fs.existsSync(rq3Dir)) return [];
  return fs.readdirSync(rq3Dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const rel = `benchmark-results/rq3/${name}`;
      const json = readJson(rel);
      if (json.rq === "RQ3a") {
        const samples = (json.samples || []).filter((sample) => sample.phaseAtCompletion === "measurement");
        const values = samples.map((sample) => sample.latencyMs).filter(Number.isFinite);
        const stdMs = json.summary?.stdCompletionLatencyMs ?? std(values);
        const n = samples.length || json.summary?.measurementCompletions || 0;
        return {
          rq: "RQ3a",
          protocol: json.protocol,
          setting: `d=${json.workload?.depth}`,
          n,
          metric: "completion latency",
          mean: fixed(json.summary?.avgCompletionLatencySeconds ?? seconds(mean(values))),
          median: fixed(json.summary?.medianCompletionLatencySeconds ?? 0),
          std: fixed(seconds(stdMs)),
          ci95: fixed(seconds(ci95(stdMs, n))),
          rel,
        };
      }
      if (json.rq === "RQ3b") {
        const values = (json.runs || []).map((run) => run.totalGas).filter(Number.isFinite);
        const stdGas = std(values);
        const n = json.summary?.runs ?? values.length;
        return {
          rq: "RQ3b",
          protocol: json.protocol,
          setting: `d=${json.depth}`,
          n,
          metric: "total gas",
          mean: fixed(json.summary?.avgTotalGas ?? mean(values), 0),
          median: fixed(values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0, 0),
          std: fixed(stdGas, 0),
          ci95: fixed(ci95(stdGas, n), 0),
          rel,
        };
      }
      if (json.rq === "RQ3c") {
        const values = (json.samples || []).map((sample) => sample.latencyMs).filter(Number.isFinite);
        const stdMs = json.summary?.stdCompletionLatencyMs ?? std(values);
        const n = values.length;
        return {
          rq: "RQ3c",
          protocol: json.protocol,
          setting: `c=${json.workload?.concurrency}`,
          n,
          metric: "completion latency",
          mean: fixed(json.summary?.avgCompletionLatencySeconds ?? seconds(mean(values))),
          median: fixed(json.summary?.medianCompletionLatencySeconds ?? 0),
          p90: fixed(json.summary?.p90CompletionLatencySeconds ?? seconds(percentile(values, 90))),
          p99: fixed(json.summary?.p99CompletionLatencySeconds ?? seconds(percentile(values, 99))),
          std: fixed(seconds(stdMs)),
          ci95: fixed(seconds(ci95(stdMs, n))),
          rel,
        };
      }
      if (json.rq === "RQ3d" || name.startsWith("translation-overhead")) {
        return {
          rq: "RQ3d",
          protocol: "XSmartContract",
          setting: "translation overhead",
          n: "deterministic",
          metric: "gas/bytecode",
          mean: "see artifact",
          median: "N/A",
          std: "0",
          ci95: "0",
          rel,
        };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => `${a.rq}-${a.protocol}-${a.setting}`.localeCompare(`${b.rq}-${b.protocol}-${b.setting}`));
}

function printTable(headers, rows) {
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(`| ${headers.map((header) => row[header] ?? "").join(" | ")} |`);
  }
}

console.log("# Results CI Summary");
console.log("");
console.log(`Generated: ${new Date().toISOString()}`);
console.log("");
console.log("## RQ1 Latency");
console.log("");
printTable(
  ["rq", "protocol", "setting", "n", "meanSeconds", "medianSeconds", "stdSeconds", "ciSeconds", "rel"],
  rq1Rows().map((row) => ({
    ...row,
    meanSeconds: fixed(row.meanSeconds),
    medianSeconds: fixed(row.medianSeconds),
    stdSeconds: fixed(row.stdSeconds),
    ciSeconds: fixed(row.ciSeconds),
  })),
);
console.log("");
console.log("## RQ3 Metrics");
console.log("");
printTable(["rq", "protocol", "setting", "n", "metric", "mean", "median", "p90", "p99", "std", "ci95", "rel"], rq3Rows());
