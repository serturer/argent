/* global artifacts */

const ethers = require("ethers");
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

const { assert, expect } = chai;
chai.use(bnChai(BN));

const WalletFactory = artifacts.require("WalletFactory");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const ArgentModule = artifacts.require("ArgentModule");
const Authoriser = artifacts.require("DappRegistry");
const UniswapV2Router01 = artifacts.require("DummyUniV2Router");
const WalletFactory = artifacts.require("WalletFactory");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const ArgentModule = artifacts.require("ArgentModule");
const Authoriser = artifacts.require("DappRegistry");
const UniswapV2Router01 = artifacts.require("DummyUniV2Router");
const ERC20 = artifacts.require("TestERC20");
const ERC721 = artifacts.require("TestERC721");
const CK = artifacts.require("CryptoKittyTest");
const ERC1155 = artifacts.require("TestERC1155");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN, encodeTransaction, addTrustedContact, initNonce } = require("../utils/utilities.js");

const ZERO_BYTES = "0x";
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const LOCK_PERIOD = 4;
const RECOVERY_PERIOD = 4;

const RelayManager = require("../utils/relay-manager");

contract("ArgentModule", (accounts) => {
  let manager;

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const sender = accounts[2];
  const guardian1 = accounts[3];
  const recipient = accounts[4];
  const refundAddress = accounts[7];
  const relayer = accounts[9];

  let registry;
  let transferStorage;
  let guardianStorage;
  let module;
  let wallet;
  let authoriser;
  let factory;

  let erc20;
  let erc721;
  let erc1155;
  let ck;

  const ckId = 0;
  const erc721Id = 7;
  const erc1155Id = 4;

  before(async () => {
    registry = await Registry.new();
    guardianStorage = await GuardianStorage.new();
    transferStorage = await TransferStorage.new();
    authoriser = await Authoriser.new(0);

    const uniswapRouter = await UniswapV2Router01.new();

    module = await ArgentModule.new(
      registry.address,
      guardianStorage.address,
      transferStorage.address,
      authoriser.address,
      uniswapRouter.address,
      SECURITY_PERIOD,
      SECURITY_WINDOW,
      RECOVERY_PERIOD,
      LOCK_PERIOD);

    await registry.registerModule(module.address, ethers.utils.formatBytes32String("ArgentModule"));
    await authoriser.addDapp(0, relayer, ZERO_ADDRESS);

    const walletImplementation = await BaseWallet.new();
    factory = await WalletFactory.new(
      walletImplementation.address,
      guardianStorage.address,
      refundAddress);
    await factory.addManager(infrastructure);

    manager = new RelayManager(guardianStorage.address, ZERO_ADDRESS);
  });

  beforeEach(async () => {
    // create wallet
    const walletAddress = await utils.createWallet(factory.address, owner, [module.address], guardian1);
    wallet = await BaseWallet.at(walletAddress);
    await wallet.send(web3.utils.toWei("1"));
    // ERC20
    erc20 = await ERC20.new([infrastructure, sender], 10000000, 12);
    // ERC721
    erc721 = await ERC721.new();
    await erc721.mint(sender, erc721Id);
    // Crypto Kitty
    ck = await CK.new();
    await ck.createDumbKitty(sender);
    // ERC1155
    erc1155 = await ERC1155.new();
    await erc1155.mint(sender, erc1155Id, 10000000);
  });

  describe("send and receive assets", () => {
    beforeEach(async () => {
      await initNonce(wallet, module, manager, SECURITY_PERIOD);
      await addTrustedContact(wallet, recipient, module, SECURITY_PERIOD);
    });

    it("should send and receive ETH", async () => {
      // receive
      let before = await utils.getBalance(wallet.address);
      await wallet.send(web3.utils.toWei("1"), { from: sender });
      let after = await utils.getBalance(wallet.address);
      expect(after.sub(before)).to.gt.BN(0);
      // send
      before = after;
      const transaction = encodeTransaction(recipient, web3.utils.toWei("1"), ZERO_BYTES);
      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success, error } = utils.parseRelayReceipt(txReceipt);
      assert.isTrue(success, `sending ETH failed with "${error}"`);
      after = await utils.getBalance(wallet.address);
      expect(after.sub(before)).to.lt.BN(0);
    });

    it("should send and receive ERC20", async () => {
      // receive
      let before = await erc20.balanceOf(wallet.address);
      await erc20.transfer(wallet.address, 10000, { from: sender });
      let after = await erc20.balanceOf(wallet.address);
      expect(after.sub(before)).to.eq.BN(10000);
      // send
      before = after;
      const data = await erc20.contract.methods.transfer(recipient, 10000).encodeABI();
      const transaction = encodeTransaction(erc20.address, 0, data, true);
      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success } = utils.parseRelayReceipt(txReceipt);
      assert.isTrue(success);
      after = await erc20.balanceOf(wallet.address);
      expect(before.sub(after)).to.eq.BN(10000);
    });

    it("should send and receive ERC721", async () => {
      // receive
      let before = await erc721.balanceOf(wallet.address);
      await erc721.safeTransferFrom(sender, wallet.address, erc721Id, { from: sender });
      let after = await erc721.balanceOf(wallet.address);
      expect(after.sub(before)).to.eq.BN(1);
      // send
      before = after;
      const data = erc721.contract.methods.safeTransferFrom(wallet.address, recipient, erc721Id).encodeABI();
      const transaction = encodeTransaction(erc721.address, 0, data, true);
      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success } = utils.parseRelayReceipt(txReceipt);
      assert.isTrue(success);
      after = await erc721.balanceOf(wallet.address);
      expect(before.sub(after)).to.eq.BN(1);
    });

    it("should send and receive CryptoKitty", async () => {
      // receive
      let before = await ck.balanceOf(wallet.address);
      await ck.transfer(wallet.address, ckId, { from: sender });
      let after = await ck.balanceOf(wallet.address);
      expect(after.sub(before)).to.eq.BN(1);
      // send
      before = after;
      const data = ck.contract.methods.transfer(recipient, ckId).encodeABI();
      const transaction = utils.encodeTransaction(ck.address, 0, data, true);
      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success } = utils.parseRelayReceipt(txReceipt);
      assert.isTrue(success);
      after = await erc721.balanceOf(wallet.address);
      expect(before.sub(after)).to.eq.BN(1);
    });

    it("should send and receive ERC1155", async () => {
      // receive
      let before = await erc1155.balanceOf(wallet.address, erc1155Id);
      await erc1155.safeTransferFrom(sender, wallet.address, erc1155Id, 1000, ZERO_BYTES, { from: sender });
      let after = await erc1155.balanceOf(wallet.address, erc1155Id);
      expect(after.sub(before)).to.eq.BN(1000);
      // send
      before = after;
      const data = erc1155.contract.methods.safeTransferFrom(wallet.address, recipient, erc1155Id, 1000, ZERO_BYTES).encodeABI();
      const transaction = encodeTransaction(erc1155.address, 0, data, true);
      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success } = utils.parseRelayReceipt(txReceipt);
      assert.isTrue(success);
      after = await erc1155.balanceOf(wallet.address, erc1155Id);
      expect(before.sub(after)).to.eq.BN(1000);
    });
  });
});
