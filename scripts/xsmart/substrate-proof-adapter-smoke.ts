import hre from "hardhat";

async function main() {
  const [owner, relayer, user] = await hre.ethers.getSigners();

  const lightClient = await hre.ethers.deployContract("LightClient", [2002n, 0n]);
  const relayerManager = await hre.ethers.deployContract("RelayerManager", [1n, 0n, 0n]);
  const registry = await hre.ethers.deployContract("UBTLRegistry");
  const adapter = await hre.ethers.deployContract("SubstrateStateProofAdapter", [
    await lightClient.getAddress(),
  ]);
  const bridge = await hre.ethers.deployContract("XBridgingContract", [
    1337n,
    await lightClient.getAddress(),
    await relayerManager.getAddress(),
    3n,
    0n,
  ]);
  const stateful = await hre.ethers.deployContract("CallTreeStatefulTarget");
  const logic = await hre.ethers.deployContract("ProofBackedImportLogic", [
    await stateful.getAddress(),
  ]);

  await bridge.setUBTLRegistry(await registry.getAddress());
  await bridge.setProofAdapter(await adapter.getAddress());
  await bridge.regState(await stateful.getAddress());
  await relayerManager.connect(relayer).registerRelayer({ value: 1n });
  await bridge.connect(relayer).regServer("travel", await logic.getAddress());
  await bridge.confirmVerification("travel", true, 0n, [], hre.ethers.ZeroHash);

  const txId = 9501n;
  const lockedState = hre.ethers.toUtf8Bytes("wasm-locked-state");
  const meta = {
    chainId: hre.ethers.id("WASM_SUBSTRATE:bc2"),
    contractId: hre.ethers.zeroPadValue(await stateful.getAddress(), 32),
    schemaHash: hre.ethers.id("schema:TrainBooking:v1"),
    opId: hre.ethers.zeroPadValue(hre.ethers.toBeHex(txId), 32),
    lockEpoch: 1n,
    stateVersion: 1n,
  };
  const proof = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "bytes32[]"],
    [21n, []],
  );
  const leaf = await adapter.stateLeaf(
    meta.chainId,
    meta.contractId,
    meta.schemaHash,
    meta.opId,
    meta.lockEpoch,
    meta.stateVersion,
    lockedState,
  );
  await lightClient.submitBlockHeader(21n, hre.ethers.ZeroHash, leaf, 1n);
  await lightClient.finalizeBlock(21n);
  await bridge.connect(user).requestLockStates(txId, "travel", [await stateful.getAddress()], 2n, 2002n);

  const verifyGas = await adapter.verify.estimateGas(
    meta.chainId,
    meta.contractId,
    meta.schemaHash,
    meta.opId,
    meta.lockEpoch,
    meta.stateVersion,
    lockedState,
    proof,
  );
  const executeGas = await bridge.connect(user).executeIntegratedLogicWithProofs.estimateGas(
    txId,
    "travel",
    [lockedState],
    [[
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      proof,
    ]],
  );

  await bridge.connect(user).executeIntegratedLogicWithProofs(
    txId,
    "travel",
    [lockedState],
    [[
      meta.chainId,
      meta.contractId,
      meta.schemaHash,
      meta.opId,
      meta.lockEpoch,
      meta.stateVersion,
      proof,
    ]],
  );

  console.log(JSON.stringify({
    mode: "zk_substrate_mvp",
    chainFamily: "WASM_SUBSTRATE",
    proofSizeBytes: hre.ethers.getBytes(proof).length,
    encodedStateSizeBytes: lockedState.length,
    adapterVerifyGas: verifyGas.toString(),
    bridgeExecuteWithProofGas: executeGas.toString(),
    owner: owner.address,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
