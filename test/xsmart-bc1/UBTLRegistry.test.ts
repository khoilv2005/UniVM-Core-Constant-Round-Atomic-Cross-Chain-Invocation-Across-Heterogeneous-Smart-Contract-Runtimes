import { expect } from "chai";
import { ethers } from "hardhat";

describe("UBTLRegistry", function () {
  async function deployAll() {
    const [owner, other] = await ethers.getSigners();
    const translated = await ethers.deployContract("VASSPApplyTarget");
    const secondTranslated = await ethers.deployContract("VASSPHarness");
    const registry = await ethers.deployContract("UBTLRegistry");

    return { owner, other, registry, translated, secondTranslated };
  }

  it("registers a translation and stores reverse lookup metadata", async function () {
    const { owner, registry, translated } = await deployAll();
    const sourceChainId = 2002n;
    const sourceHash = ethers.id("fabric:hotel");
    const irHash = ethers.id("ir:hotel");
    const storageMapRoot = ethers.id("storage:hotel");

    await expect(
      registry.register(sourceChainId, sourceHash, irHash, translated, storageMapRoot)
    )
      .to.emit(registry, "TranslationRegistered");

    const key = await registry.keyFor(sourceChainId, sourceHash);
    const stored = await registry.translations(key);

    expect(stored.sourceChainId).to.equal(sourceChainId);
    expect(stored.sourceContractHash).to.equal(sourceHash);
    expect(stored.irHash).to.equal(irHash);
    expect(stored.translated).to.equal(await translated.getAddress());
    expect(stored.storageMapRoot).to.equal(storageMapRoot);
    expect(stored.dAppProvider).to.equal(owner.address);
    expect(await registry.byTranslated(await translated.getAddress())).to.equal(key);
  });

  it("rejects duplicate registration by source key or translated address", async function () {
    const { registry, translated, secondTranslated } = await deployAll();
    const sourceChainId = 2002n;
    const sourceHash = ethers.id("fabric:hotel");
    const irHash = ethers.id("ir:hotel");
    const storageMapRoot = ethers.id("storage:hotel");

    await registry.register(sourceChainId, sourceHash, irHash, translated, storageMapRoot);

    const key = await registry.keyFor(sourceChainId, sourceHash);
    await expect(
      registry.register(sourceChainId, sourceHash, irHash, secondTranslated, storageMapRoot)
    )
      .to.be.revertedWithCustomError(registry, "TranslationAlreadyRegistered")
      .withArgs(key);

    await expect(
      registry.register(3003n, ethers.id("other:source"), irHash, translated, storageMapRoot)
    )
      .to.be.revertedWithCustomError(registry, "TranslatedAddressAlreadyBound");
  });

  it("verifies a matching peer IR hash and latches success", async function () {
    const { registry, translated } = await deployAll();
    const sourceChainId = 2002n;
    const sourceHash = ethers.id("fabric:hotel");
    const irHash = ethers.id("ir:hotel");

    await registry.register(
      sourceChainId,
      sourceHash,
      irHash,
      translated,
      ethers.id("storage:hotel")
    );

    const key = await registry.keyFor(sourceChainId, sourceHash);
    await expect(registry.verify(key, irHash, "0x"))
      .to.emit(registry, "TranslationVerified")
      .withArgs(key, true);
    expect(await registry.verified(key)).to.equal(true);

    await expect(registry.verify(key, ethers.id("wrong"), "0x"))
      .to.emit(registry, "TranslationVerified")
      .withArgs(key, true);
    expect(await registry.verified(key)).to.equal(true);
  });

  it("returns false on mismatched peer IR hash before verification succeeds", async function () {
    const { registry, translated } = await deployAll();
    const sourceChainId = 2002n;
    const sourceHash = ethers.id("fabric:hotel");
    const irHash = ethers.id("ir:hotel");

    await registry.register(
      sourceChainId,
      sourceHash,
      irHash,
      translated,
      ethers.id("storage:hotel")
    );

    const key = await registry.keyFor(sourceChainId, sourceHash);
    expect(await registry.verify.staticCall(key, ethers.id("wrong"), "0x")).to.equal(false);
    await expect(registry.verify(key, ethers.id("wrong"), "0x"))
      .to.emit(registry, "TranslationVerified")
      .withArgs(key, false);
    expect(await registry.verified(key)).to.equal(false);
  });

  it("rejects unknown keys and EOAs as translated targets", async function () {
    const { other, registry } = await deployAll();
    const key = await registry.keyFor(9999n, ethers.id("missing"));

    await expect(registry.verify(key, ethers.id("missing"), "0x"))
      .to.be.revertedWithCustomError(registry, "UnknownTranslation")
      .withArgs(key);

    await expect(
      registry.connect(other).register(9999n, ethers.id("eoa"), ethers.id("ir"), other.address, ethers.ZeroHash)
    )
      .to.be.revertedWithCustomError(registry, "NotContract");
  });
});
