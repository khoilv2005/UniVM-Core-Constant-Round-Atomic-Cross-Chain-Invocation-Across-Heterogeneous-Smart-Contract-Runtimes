import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const out = path.join("deployments", "xsmart", "rq2-vm.json");
  const existing = fs.existsSync(out)
    ? JSON.parse(fs.readFileSync(out, "utf8").replace(/^\uFEFF/, ""))
    : { system: "xsmart", network: "rq2-vm", contracts: {} };

  const deploy = async (name: string, args: unknown[] = []) => {
    const contract = await ethers.deployContract(name, args);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    console.log(`${name}=${address}`);
    existing.contracts[name] = address;
  };

  await deploy("TokenTransferOriginal");
  await deploy("HotelBookingTranslated");
  await deploy("TokenTransferTranslated");
  await deploy("TrainBookingTranslated", ["Org1MSP", 10, 100000, 1]);
  await deploy("AuctionLogicTranslated");
  await deploy("DEXSwapTranslated");

  existing.deployedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(existing, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
