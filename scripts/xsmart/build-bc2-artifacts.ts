import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { banner, repoRoot } from "../common";

const BUILDER_IMAGE = "xsmart-ink-builder:local";

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function ensureArtifact(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing artifact after build: ${filePath}`);
  }
}

function dockerBuildBuilder(root: string) {
  const dockerfile = path.join(root, "docker", "xsmart-ink-builder.Dockerfile");
  run("docker", ["build", "-t", BUILDER_IMAGE, "-f", dockerfile, root], root);
}

function dockerBuildContract(crateDir: string) {
  run(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${crateDir}:/work`,
      "-w",
      "/work",
      BUILDER_IMAGE,
      "cargo",
      "contract",
      "build",
      "--release",
    ],
    crateDir
  );
}

async function main() {
  banner("xsmart", "bc2-build");
  const root = repoRoot();
  const stateCrateDir = path.join(root, "contracts", "xsmart", "bc2");
  const bridgeCrateDir = path.join(root, "contracts", "xsmart", "bc2", "bridge");

  const stateArtifact = path.join(stateCrateDir, "target", "ink", "train_booking.contract");
  const bridgeArtifact = path.join(bridgeCrateDir, "target", "ink", "xbridge_bc2.contract");

  console.log("  [docker] build ink! builder image");
  dockerBuildBuilder(root);

  console.log("  [build] train_booking (ink! via docker)");
  dockerBuildContract(stateCrateDir);
  ensureArtifact(stateArtifact);

  console.log("  [build] xbridge_bc2 (ink! via docker)");
  dockerBuildContract(bridgeCrateDir);
  ensureArtifact(bridgeArtifact);

  console.log(`  [artifact] ${stateArtifact}`);
  console.log(`  [artifact] ${bridgeArtifact}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
