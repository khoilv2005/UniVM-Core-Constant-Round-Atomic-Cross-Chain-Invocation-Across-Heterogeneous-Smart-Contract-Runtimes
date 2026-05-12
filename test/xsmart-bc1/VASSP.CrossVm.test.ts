import { expect } from "chai";
import { ethers } from "hardhat";

function wasmSlotIdFor(contractName: string, slotName: string, keys: string[]): string {
  const packed = ethers.concat([
    ethers.toUtf8Bytes("VASSP"),
    ethers.toUtf8Bytes(contractName),
    ethers.toUtf8Bytes(slotName),
    ...keys.map((key) => ethers.getBytes(key)),
  ]);
  return ethers.keccak256(packed);
}

function fabricSlotIdFor(contractName: string, slotName: string, keys: string[]): string {
  const packed = ethers.concat([
    ethers.toUtf8Bytes("VASSP"),
    ethers.toUtf8Bytes(contractName),
    ethers.toUtf8Bytes(slotName),
    ...keys.map((key) => ethers.getBytes(key)),
  ]);
  return ethers.keccak256(packed);
}

describe("XSmart VASSP Cross-VM slot id", function () {
  it("matches the ink! and Fabric helpers for scalar and keyed slots", async function () {
    const harness = await ethers.deployContract("VASSPHarness");

    const cases = [
      { contractName: "HotelBooking", slotName: "META", keys: [] as string[] },
      { contractName: "HotelBooking", slotName: "LOCK_TOTAL", keys: [] as string[] },
      { contractName: "HotelBooking", slotName: "ACCOUNT_%s", keys: [ethers.toUtf8Bytes("alice")] },
      { contractName: "TrainBooking", slotName: "locks", keys: ["0x1234", "0xabcd"] },
    ];

    for (const tc of cases) {
      const soliditySlot = await harness.slotIdFor.staticCall(tc.contractName, tc.slotName, tc.keys);
      const wasmSlot = wasmSlotIdFor(tc.contractName, tc.slotName, tc.keys);
      const fabricSlot = fabricSlotIdFor(tc.contractName, tc.slotName, tc.keys);

      expect(soliditySlot).to.equal(wasmSlot);
      expect(soliditySlot).to.equal(fabricSlot);
    }
  });
});
