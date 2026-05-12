import { AbiCoder, getBytes, hexlify, isHexString } from "ethers";
import * as fs from "fs";

type HostOutput = {
  public_values?: string;
  proof?: string;
  seal?: string;
  adapter_proof?: string;
};

function requireHex(value: unknown, name: string): string {
  if (typeof value !== "string" || !isHexString(value)) {
    throw new Error(`${name} must be a 0x-prefixed hex string`);
  }
  return value;
}

function main(): void {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    throw new Error("Usage: ts-node scripts/zk/package-succinct-proof.ts <host-output.json> [out.json]");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as HostOutput;
  if (input.adapter_proof && isHexString(input.adapter_proof)) {
    console.log(input.adapter_proof);
    if (outputPath) {
      fs.writeFileSync(outputPath, JSON.stringify({ adapter_proof: input.adapter_proof }, null, 2));
    }
    return;
  }

  const publicValues = requireHex(input.public_values, "public_values");
  const proofBytes = requireHex(input.proof || input.seal, "proof/seal");
  const adapterProof = AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes"],
    [hexlify(getBytes(publicValues)), hexlify(getBytes(proofBytes))],
  );
  console.log(adapterProof);
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({ adapter_proof: adapterProof }, null, 2));
  }
}

main();
