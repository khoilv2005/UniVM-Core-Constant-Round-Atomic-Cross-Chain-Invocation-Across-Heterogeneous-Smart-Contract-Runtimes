import * as fs from "fs";
import * as path from "path";
import {
  ensureDir,
  loadDeployment,
  manifestsDir,
  requireContractAddress,
} from "../common";

async function main() {
  const bc2Deployment = loadDeployment("gpact", "bc2");
  const bc3Deployment = loadDeployment("gpact", "bc3");

  const hotel = requireContractAddress(bc2Deployment, "gpactHotel");
  const train = requireContractAddress(bc3Deployment, "gpactTrain");

  const manifest = {
    workflow_id: "gpact-train-hotel-write",
    root_chain_id: 1,
    segments: [
      {
        segment_id: 1,
        chain_id: 2,
        contract: hotel,
        function: "hotel",
        kind: "hotel",
      },
      {
        segment_id: 2,
        chain_id: 3,
        contract: train,
        function: "train",
        kind: "train",
      },
    ],
  };

  const outputDir = manifestsDir("gpact");
  ensureDir(outputDir);
  const outputPath = path.join(outputDir, "train-hotel-write.generated.json");
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`Rendered GPACT manifest: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
