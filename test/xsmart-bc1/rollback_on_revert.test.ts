import { expect } from "chai";
import { ethers } from "hardhat";

type TreeNode = {
  contractAddr: string;
  selector: string;
  args: string;
  argChildIdx: bigint[];
  children: bigint[];
};

const MAX = (1n << 256n) - 1n;

function word(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function encodeArgs(...values: bigint[]): string {
  return ethers.concat(values.map(word));
}

function encodeTree(nodes: TreeNode[], rootIndex: bigint): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    [
      "tuple(address contractAddr, bytes4 selector, bytes args, uint256[] argChildIdx, uint256[] children)[]",
      "uint256",
    ],
    [nodes, rootIndex]
  );
}

describe("CallTree rollback", function () {
  it("reverts the whole transaction when a downstream node fails", async function () {
    const harness = await ethers.deployContract("CallTreeExecutorHarness");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");
    const math = await ethers.deployContract("CallTreeMathTarget");

    const nodes: TreeNode[] = [
      {
        contractAddr: await stateful.getAddress(),
        selector: stateful.interface.getFunction("setValue")!.selector,
        args: encodeArgs(7n),
        argChildIdx: [MAX],
        children: [],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("alwaysFail")!.selector,
        args: encodeArgs(0n),
        argChildIdx: [0n],
        children: [0n],
      },
    ];

    const blob = encodeTree(nodes, 1n);

    await expect(harness.execute(blob)).to.be.revertedWithCustomError(harness, "NodeCallFailed");
    expect(await stateful.stored()).to.equal(0n);
  });
});
