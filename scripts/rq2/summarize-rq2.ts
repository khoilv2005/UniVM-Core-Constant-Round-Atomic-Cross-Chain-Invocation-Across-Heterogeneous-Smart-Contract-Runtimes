import fs from "fs";
import path from "path";

type ResultFile = {
  contract: string;
  status?: string;
  runs: number;
  pass: number;
  fail: number;
  passRate: number | null;
  failByCategory?: Record<string, number>;
  note?: string;
};

const CONTRACTS = ["HotelBooking", "TrainBooking", "TokenTransfer", "AuctionLogic", "DEXSwap"];

function readResult(contract: string): ResultFile {
  const filePath = path.join("benchmark-results", "rq2", "results", `${contract}.json`);
  if (!fs.existsSync(filePath)) {
    return {
      contract,
      status: "not_run",
      runs: 0,
      pass: 0,
      fail: 0,
      passRate: null,
      note: "No result artifact found.",
    };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ResultFile;
}

function pct(value: number | null): string {
  if (value === null) return "N/A";
  return `${(value * 100).toFixed(2)}%`;
}

function main() {
  const results = CONTRACTS.map(readResult);
  console.log(JSON.stringify(results, null, 2));
}

main();
