import fs from "fs";
import path from "path";

type SemanticResult = {
  contract: string;
  runs: number;
  pass: number;
  fail: number;
  passRate: number;
  failByCategory?: Record<string, number>;
};

type VmSmokeResult = {
  generatedAt: string;
  runs: number;
  pass: number;
  fail: number;
  passRate: number;
  results: Array<{
    contract: string;
    originalVm: string;
    translatedVm: string;
    pass: boolean;
    detail: Record<string, string>;
  }>;
};

type VmFullResult = {
  generatedAt: string;
  contract: string;
  runs: number;
  pass: number;
  fail: number;
  passRate: number;
  failures?: unknown[];
};

const contracts = ["HotelBooking", "TrainBooking", "TokenTransfer", "AuctionLogic", "DEXSwap"];
const resultDir = path.join("benchmark-results", "rq2", "results");
const outJson = path.join(resultDir, "rq2a-hybrid-summary.json");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function liveFileFor(contract: string): string | null {
  const candidates = [
    path.join(resultDir, `${contract}-vm-live30.json`),
    path.join(resultDir, `${contract}-vm-full.json`),
    path.join(resultDir, `${contract}-vm-200.json`),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function main() {
  const semantic = contracts.map((contract) => {
    const file = path.join(resultDir, `${contract}.json`);
    const result = readJson<SemanticResult>(file);
    return {
      contract,
      mode: "semantic-equivalence-1000",
      runs: result.runs,
      pass: result.pass,
      fail: result.fail,
      passRate: result.passRate,
      failByCategory: result.failByCategory ?? {},
      artifact: file.split(path.sep).join("/"),
    };
  });

  const liveVm = contracts.map((contract) => {
    const file = liveFileFor(contract);
    if (file === null) {
      return {
        contract,
        mode: "live-vm-sequences",
        runs: 0,
        pass: 0,
        fail: 0,
        passRate: 0,
        artifact: "",
        status: "missing",
      };
    }
    const result = readJson<VmFullResult>(file);
    return {
      contract,
      mode: "live-vm-sequences",
      runs: result.runs,
      pass: result.pass,
      fail: result.fail,
      passRate: result.passRate,
      artifact: file.split(path.sep).join("/"),
      status: result.fail === 0 ? "pass" : "fail",
    };
  });
  const vmSmokeFile = path.join(resultDir, "vm-smoke.json");
  const vmSmoke = fs.existsSync(vmSmokeFile) ? readJson<VmSmokeResult>(vmSmokeFile) : null;
  const summary = {
    schemaVersion: 1,
    rq: "RQ2a",
    methodology: "hybrid-correctness",
    generatedAt: new Date().toISOString(),
    rq2a1: {
      name: "large-scale semantic equivalence",
      description: "1000 randomized cases per contract; compares canonical logical state snapshots.",
      totalRuns: semantic.reduce((sum, row) => sum + row.runs, 0),
      totalPass: semantic.reduce((sum, row) => sum + row.pass, 0),
      totalFail: semantic.reduce((sum, row) => sum + row.fail, 0),
      contracts: semantic,
    },
    rq2a2: {
      name: "live VM differential sequence validation",
      description: "Randomized native-VM operation sequences compared with translated EVM behavior on the VM testbed. The live30 runner produces 30 sequences per contract.",
      totalRuns: liveVm.reduce((sum, row) => sum + row.runs, 0),
      totalPass: liveVm.reduce((sum, row) => sum + row.pass, 0),
      totalFail: liveVm.reduce((sum, row) => sum + row.fail, 0),
      contracts: liveVm,
      fallbackSmoke: vmSmoke
        ? {
            artifact: vmSmokeFile.split(path.sep).join("/"),
            runs: vmSmoke.runs,
            pass: vmSmoke.pass,
            fail: vmSmoke.fail,
          }
        : null,
    },
    note:
      "RQ2a does not run 1000 cases per contract as per-operation live VM transactions because block-time/finality overhead makes that operationally prohibitive. The large-scale part tests semantic correctness; live VM sequences validate that the same execution paths are reachable on the heterogeneous VM testbed.",
  };

  fs.writeFileSync(outJson, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({
    outJson,
    semanticRuns: summary.rq2a1.totalRuns,
    semanticPass: summary.rq2a1.totalPass,
    semanticFail: summary.rq2a1.totalFail,
    vmRuns: summary.rq2a2.totalRuns,
    vmPass: summary.rq2a2.totalPass,
    vmFail: summary.rq2a2.totalFail,
  }, null, 2));
}

main();
