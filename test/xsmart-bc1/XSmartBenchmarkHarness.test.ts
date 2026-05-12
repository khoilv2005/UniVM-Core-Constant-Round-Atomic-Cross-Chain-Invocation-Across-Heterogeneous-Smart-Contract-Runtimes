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

describe("XSmartBenchmarkHarness", function () {
  async function deployAll() {
    const [owner, relayer, caller] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [1337n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      10n,
      ethers.parseEther("0.01"),
    ]);

    const math = await ethers.deployContract("CallTreeMathTarget");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");
    const harness = await ethers.deployContract("XSmartBenchmarkHarness", [await bridge.getAddress()]);

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.regState(await stateful.getAddress());

    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await math.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, caller, registry, bridge, math, stateful, harness };
  }

  async function registerTranslation(registry: any, translated: string) {
    const sourceChainId = 2002n;
    const sourceHash = ethers.id("source:xsmart-benchmark-harness");
    const irHash = ethers.id("ir:xsmart-benchmark-harness");
    await registry.register(sourceChainId, sourceHash, irHash, translated, ethers.ZeroHash);
    const key = await registry.keyFor(sourceChainId, sourceHash);
    return { key, irHash };
  }

  it("rejects the old single-transaction shortcut without update ACKs", async function () {
    const { bridge, registry, caller, math, stateful, harness } = await deployAll();
    const translation = await registerTranslation(registry, await math.getAddress());

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
    ];
    const blob = encodeTree(nodes, 2n);
    const txId = 1n;
    const fee = await bridge.crossChainFee();

    await expect(
      harness.connect(caller).runSingleTx(
        txId,
        "travel",
        [await stateful.getAddress()],
        30n,
        2002n,
        blob,
        [translation.key],
        [translation.irHash],
        await caller.getAddress(),
        { value: fee }
      )
    ).to.be.revertedWith("Missing update acks");

    const exec = await bridge.activeExecutions(txId);
    expect(exec.active).to.equal(false);
    expect(await bridge.pendingWithdrawals(await harness.getAddress())).to.equal(0n);
  });
});
