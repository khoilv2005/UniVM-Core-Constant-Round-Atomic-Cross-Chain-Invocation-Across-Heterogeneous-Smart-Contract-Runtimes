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

describe("CallTree Executor", function () {
  it("executes a five-node tree end-to-end and returns the hand-computed root result", async function () {
    const harness = await ethers.deployContract("CallTreeExecutorHarness");
    const math = await ethers.deployContract("CallTreeMathTarget");

    const nodes: TreeNode[] = [
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(5n),
        argChildIdx: [MAX],
        children: [],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(7n),
        argChildIdx: [MAX],
        children: [],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("add")!.selector,
        args: encodeArgs(0n, 0n),
        argChildIdx: [0n, 1n],
        children: [0n, 1n],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(3n),
        argChildIdx: [MAX],
        children: [],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("mul")!.selector,
        args: encodeArgs(0n, 0n),
        argChildIdx: [2n, 3n],
        children: [2n, 3n],
      },
    ];

    const blob = encodeTree(nodes, 4n);
    const [results, rootResult] = await harness.execute.staticCall(blob);

    const coder = ethers.AbiCoder.defaultAbiCoder();
    expect(coder.decode(["uint256"], results[0])[0]).to.equal(5n);
    expect(coder.decode(["uint256"], results[1])[0]).to.equal(7n);
    expect(coder.decode(["uint256"], results[2])[0]).to.equal(12n);
    expect(coder.decode(["uint256"], results[3])[0]).to.equal(3n);
    expect(coder.decode(["uint256"], rootResult)[0]).to.equal(36n);

    await expect(harness.execute(blob))
      .to.emit(harness, "NodeExecuted")
      .withArgs(4n, coder.encode(["uint256"], [36n]));
  });
});
