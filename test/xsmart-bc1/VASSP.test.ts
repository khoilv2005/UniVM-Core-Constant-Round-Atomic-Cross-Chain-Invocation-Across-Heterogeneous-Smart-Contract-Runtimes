import { expect } from "chai";
import { ethers } from "hardhat";

describe("XSmart VASSP", function () {
  it("computes the canonical slot id deterministically", async function () {
    const harness = await ethers.deployContract("VASSPHarness");

    const keys = ["0x1234", "0xabcd"];
    const slotId = await harness.slotIdFor.staticCall("HotelBooking", "LOCK_%s", keys);

    const expected = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "string", "string", "bytes", "bytes"],
        ["VASSP", "HotelBooking", "LOCK_%s", keys[0], keys[1]]
      )
    );

    expect(slotId).to.equal(expected);
  });

  it("round-trips encoded pairs through RLP", async function () {
    const harness = await ethers.deployContract("VASSPHarness");

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const contractName = "HotelBooking";
    const slotIds = [
      await harness.slotIdFor.staticCall(contractName, "META", []),
      await harness.slotIdFor.staticCall(contractName, "LOCK_TOTAL", []),
    ];
    const values = [
      coder.encode(["string", "uint256", "uint256", "uint256"], ["bridgeMSP", 10n, 100n, 1n]),
      coder.encode(["uint256"], [50n]),
    ];

    const encoded = await harness.encodePairs.staticCall(slotIds, values);
    const [decodedSlotIds, decodedValues] = await harness.decodePairs.staticCall(encoded);

    expect(decodedSlotIds).to.deep.equal(slotIds);
    expect(decodedValues).to.deep.equal(values);
  });

  it("decodes and applies VASSP payloads to the translated target", async function () {
    const harness = await ethers.deployContract("VASSPHarness");
    const target = await ethers.deployContract("VASSPApplyTarget");

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const contractName = "HotelBooking";
    const slotIds = [
      await harness.slotIdFor.staticCall(contractName, "META", []),
      await harness.slotIdFor.staticCall(contractName, "LOCK_TOTAL", []),
    ];
    const values = [
      coder.encode(["string", "uint256", "uint256", "uint256"], ["bridgeMSP", 25n, 90n, 3n]),
      coder.encode(["uint256"], [75n]),
    ];

    const encoded = await harness.encodePairs.staticCall(slotIds, values);
    await harness.decodeAndApply(target, encoded, ethers.ZeroHash);

    expect(await target.bridge()).to.equal("bridgeMSP");
    expect(await target.price()).to.equal(25n);
    expect(await target.remain()).to.equal(90n);
    expect(await target.lockSize()).to.equal(3n);
    expect(await target.lockedTotal()).to.equal(75n);
    expect(await target.lastSlot()).to.equal(slotIds[1]);
    expect(await target.lastValue()).to.equal(values[1]);
  });

  it("rejects malformed RLP payloads", async function () {
    const harness = await ethers.deployContract("VASSPHarness");

    await expect(
      harness.decodePairs.staticCall("0xc501820102")
    ).to.be.revertedWithCustomError(harness, "InvalidRlp");
  });
});
