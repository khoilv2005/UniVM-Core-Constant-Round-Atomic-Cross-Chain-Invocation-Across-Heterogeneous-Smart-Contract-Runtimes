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

describe("CallTree", function () {
  it("parses a tree, returns topological order, and substitutes child results", async function () {
    const harness = await ethers.deployContract("CallTreeExecutorHarness");
    const math = await ethers.deployContract("CallTreeMathTarget");

    const nodes: TreeNode[] = [
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(3n),
        argChildIdx: [MAX],
        children: [],
      },
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(4n),
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
        args: encodeArgs(2n),
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
    const order = await harness.parseAndOrder.staticCall(blob);
    expect(order.map((x) => Number(x))).to.deep.equal([0, 1, 2, 3, 4]);

    const results = [
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [3n]),
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [4n]),
      "0x",
      "0x",
      "0x",
    ];
    const materialized = await harness.materializeForNode.staticCall(blob, 2n, results);
    const [lhs, rhs] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], materialized);
    expect(lhs).to.equal(3n);
    expect(rhs).to.equal(4n);
  });
});
