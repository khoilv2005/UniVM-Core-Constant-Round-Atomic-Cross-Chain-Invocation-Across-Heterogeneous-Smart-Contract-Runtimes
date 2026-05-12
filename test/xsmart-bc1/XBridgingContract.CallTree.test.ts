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

describe("XBridgingContract CallTree", function () {
  async function deployAll() {
    const [owner, relayer, user] = await ethers.getSigners();

    const lightClient = await ethers.deployContract("LightClient", [2002n, 0n]);
    const relayerManager = await ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
    const registry = await ethers.deployContract("UBTLRegistry");
    const bridge = await ethers.deployContract("XBridgingContract", [
      1337n,
      await lightClient.getAddress(),
      await relayerManager.getAddress(),
      10n,
      0n,
    ]);

    const math = await ethers.deployContract("CallTreeMathTarget");
    const stateful = await ethers.deployContract("CallTreeStatefulTarget");

    await bridge.setUBTLRegistry(await registry.getAddress());
    await bridge.regState(await stateful.getAddress());

    await relayerManager.connect(relayer).registerRelayer({ value: 1n });
    await bridge.connect(relayer).regServer("travel", await math.getAddress());
    await bridge.confirmVerification("travel", true, 0n, [], ethers.ZeroHash);

    return { owner, relayer, user, lightClient, relayerManager, registry, bridge, math, stateful };
  }

  async function registerTranslation(
    registry: any,
    translated: string,
    label: string,
    irLabel = label
  ) {
    const sourceChainId = 2002n;
    const sourceHash = ethers.id(`source:${label}`);
    const irHash = ethers.id(`ir:${irLabel}`);
    await registry.register(sourceChainId, sourceHash, irHash, translated, ethers.ZeroHash);
    const key = await registry.keyFor(sourceChainId, sourceHash);
    return { key, irHash };
  }

  function singleSeedTree(math: any, value: bigint): TreeNode[] {
    return [{
      contractAddr: math.target as string,
      selector: math.interface.getFunction("seed")!.selector,
      args: encodeArgs(value),
      argChildIdx: [MAX],
      children: [],
    }];
  }

  it("executes a verified call tree through the bridge", async function () {
    const { bridge, registry, relayer, user, math, stateful } = await deployAll();
    const translation = await registerTranslation(registry, await math.getAddress(), "math");

    const txId = 1n;
    await bridge.connect(user).requestLockStates(txId, "travel", [await stateful.getAddress()], 10n, 2002n);

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

    const [ok, rootResult] = await bridge.connect(user).executeIntegratedCallTree.staticCall(
      txId,
      "travel",
      blob,
      [translation.key],
      [translation.irHash]
    );

    const coder = ethers.AbiCoder.defaultAbiCoder();
    expect(ok).to.equal(true);
    expect(coder.decode(["uint256"], rootResult)[0]).to.equal(36n);

    await expect(
      bridge.connect(user).executeIntegratedCallTree(
        txId,
        "travel",
        blob,
        [translation.key],
        [translation.irHash]
      )
    )
      .to.emit(bridge, "CallTreeNodeExecuted")
      .withArgs(txId, 4n, await math.getAddress(), coder.encode(["uint256"], [36n]));

    const exec = await bridge.activeExecutions(txId);
    expect(exec.active).to.equal(true);
    expect(exec.phase).to.equal(2n); // CommitDecided

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ethers.id("bc2:stateful"),
        true,
        0n,
        [],
        ethers.ZeroHash
      )
    )
      .to.emit(bridge, "ExecutionCompleted")
      .withArgs(txId, await relayer.getAddress());

    const completedExec = await bridge.activeExecutions(txId);
    expect(completedExec.active).to.equal(false);
    expect(completedExec.phase).to.equal(4n); // Completed
  });

  it("rejects update ACKs before a commit decision exists", async function () {
    const { bridge, relayer, user, stateful } = await deployAll();

    const txId = 4n;
    await bridge.connect(user).requestLockStates(txId, "travel", [await stateful.getAddress()], 10n, 2002n);

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ethers.id("bc2:stateful"),
        true,
        0n,
        [],
        ethers.ZeroHash
      )
    ).to.be.revertedWith("Commit not decided");
  });

  it("does not rollback after commit when only part of the update ACKs arrived", async function () {
    const { bridge, registry, relayer, user, math, stateful } = await deployAll();
    const secondStateful = await ethers.deployContract("CallTreeStatefulTarget");
    await bridge.regState(await secondStateful.getAddress());
    const translation = await registerTranslation(registry, await math.getAddress(), "math");

    const txId = 5n;
    await bridge.connect(user).requestLockStates(
      txId,
      "travel",
      [await stateful.getAddress(), await secondStateful.getAddress()],
      1n,
      2002n
    );

    const blob = encodeTree(singleSeedTree(math, 11n), 0n);
    await bridge.connect(user).executeIntegratedCallTree(
      txId,
      "travel",
      blob,
      [translation.key],
      [translation.irHash]
    );

    const committedExec = await bridge.activeExecutions(txId);
    expect(committedExec.active).to.equal(true);
    expect(committedExec.phase).to.equal(2n); // CommitDecided

    const ackOne = ethers.id("bc2:stateful:first");
    await bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
      txId,
      ackOne,
      true,
      0n,
      [],
      ethers.ZeroHash
    );

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ackOne,
        true,
        0n,
        [],
        ethers.ZeroHash
      )
    ).to.be.revertedWith("Ack already recorded");

    await ethers.provider.send("hardhat_mine", ["0x05"]);
    await expect(bridge.timeoutExecution(txId)).to.be.revertedWith("Commit already decided");

    const afterTimeout = await bridge.activeExecutions(txId);
    expect(afterTimeout.active).to.equal(true);
    expect(afterTimeout.phase).to.equal(2n); // CommitDecided
    expect(afterTimeout.updateAckCount).to.equal(1n);

    await expect(
      bridge.connect(relayer).recordUpdateAckAndMaybeComplete(
        txId,
        ethers.id("bc3:stateful:second"),
        true,
        0n,
        [],
        ethers.ZeroHash
      )
    )
      .to.emit(bridge, "ExecutionCompleted")
      .withArgs(txId, await relayer.getAddress());

    const completedExec = await bridge.activeExecutions(txId);
    expect(completedExec.active).to.equal(false);
    expect(completedExec.phase).to.equal(4n); // Completed
  });

  it("allows idempotent update retry after commit and rejects payload drift", async function () {
    const { bridge, registry, relayer, user, math, stateful } = await deployAll();
    const translation = await registerTranslation(registry, await math.getAddress(), "math");

    const txId = 6n;
    const statefulAddress = await stateful.getAddress();
    await bridge.connect(user).requestLockStates(txId, "travel", [statefulAddress], 10n, 2002n);

    const blob = encodeTree(singleSeedTree(math, 13n), 0n);
    await bridge.connect(user).executeIntegratedCallTree(
      txId,
      "travel",
      blob,
      [translation.key],
      [translation.irHash]
    );

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const updateData = [coder.encode(["uint256"], [13n])];
    await expect(bridge.connect(relayer).requestUpdate(txId, [statefulAddress], updateData))
      .to.emit(bridge, "CrossChainUpdateRequested")
      .withArgs(txId, [statefulAddress], updateData);

    await expect(bridge.connect(relayer).requestUpdate(txId, [statefulAddress], updateData))
      .to.emit(bridge, "CrossChainUpdateRequested")
      .withArgs(txId, [statefulAddress], updateData);

    await expect(
      bridge.connect(relayer).requestUpdate(txId, [statefulAddress], [coder.encode(["uint256"], [14n])])
    ).to.be.revertedWith("Update payload mismatch");

    await expect(
      bridge.connect(relayer).requestUpdate(txId, [await math.getAddress()], updateData)
    ).to.be.revertedWith("Unexpected state contract");
  });

  it("aborts when translation commitment verification fails", async function () {
    const { bridge, registry, user, math, stateful } = await deployAll();
    const translation = await registerTranslation(registry, await math.getAddress(), "math");

    const txId = 2n;
    await bridge.connect(user).requestLockStates(txId, "travel", [await stateful.getAddress()], 10n, 2002n);

    const blob = encodeTree(
      [{
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
        args: encodeArgs(5n),
        argChildIdx: [MAX],
        children: [],
      }],
      0n
    );

    expect(
      await bridge.connect(user).executeIntegratedCallTree.staticCall(
        txId,
        "travel",
        blob,
        [translation.key],
        [ethers.id("wrong-ir")]
      ).then((x: any) => x[0])
    ).to.equal(false);

    await expect(
      bridge.connect(user).executeIntegratedCallTree(
        txId,
        "travel",
        blob,
        [translation.key],
        [ethers.id("wrong-ir")]
      )
    )
      .to.emit(bridge, "TranslationVerificationFailed")
      .withArgs(txId, translation.key, ethers.id("wrong-ir"));

    const exec = await bridge.activeExecutions(txId);
    expect(exec.active).to.equal(false);
    expect(exec.phase).to.equal(3n); // AbortDecided
  });

  it("emits rollback and deactivates the execution when a node reverts", async function () {
    const { bridge, registry, user, math, stateful } = await deployAll();
    const translation = await registerTranslation(registry, await math.getAddress(), "math");

    const txId = 3n;
    await bridge.connect(user).requestLockStates(txId, "travel", [await stateful.getAddress()], 10n, 2002n);

    const nodes: TreeNode[] = [
      {
        contractAddr: await math.getAddress(),
        selector: math.interface.getFunction("seed")!.selector,
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

    expect(
      await bridge.connect(user).executeIntegratedCallTree.staticCall(
        txId,
        "travel",
        blob,
        [translation.key],
        [translation.irHash]
      ).then((x: any) => x[0])
    ).to.equal(false);

    await expect(
      bridge.connect(user).executeIntegratedCallTree(
        txId,
        "travel",
        blob,
        [translation.key],
        [translation.irHash]
      )
    )
      .to.emit(bridge, "IntegratedExecutionFailed")
      .and.to.emit(bridge, "CrossChainRollback");

    const exec = await bridge.activeExecutions(txId);
    expect(exec.active).to.equal(false);
    expect(exec.phase).to.equal(3n); // AbortDecided

    await expect(
      bridge.connect(user).requestUpdate(txId, [await stateful.getAddress()], [encodeArgs(1n)])
    ).to.be.revertedWith("Not active");
  });
});
