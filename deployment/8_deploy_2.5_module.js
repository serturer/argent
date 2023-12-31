/* global artifacts */
global.web3 = web3;
global.artifacts = artifacts;

const semver = require("semver");
const childProcess = require("child_process");

const MultiSig = artifacts.require("MultiSigWallet");
const ModuleRegistry = artifacts.require("ModuleRegistry");
const ArgentModule = artifacts.require("ArgentModule");
const Upgrader = artifacts.require("SimpleUpgrader");

const deployManager = require("../utils/deploy-manager.js");
const MultisigExecutor = require("../utils/multisigexecutor.js");

const utils = require("../utils/utilities.js");

const TARGET_VERSION = "2.5.0";
const MODULES_TO_ENABLE = [
  "ArgentModule",
];
const MODULES_TO_DISABLE = [
  "VersionManager",
  "MakerV2Manager",
  "TokenExchanger",
  "LockManager",
  "RecoveryManager",
  "TransferManager",
  "NftTransfer",
  "RelayerManager",
  "CompoundManager",
  "GuardianManager",
  "ApprovedTransfer",
  "UniswapManager",
  "MakerManager",
  "DappManager",
  "ModuleManager",
  "TokenTransfer"
];

const BACKWARD_COMPATIBILITY = 5;

const main = async () => {
  const { deploymentAccount, configurator, versionUploader, abiUploader } = await deployManager.getProps();

  const newModuleWrappers = [];
  const newVersion = {};

  // //////////////////////////////////
  // Setup
  // //////////////////////////////////

  const { config } = configurator;
  const ModuleRegistryWrapper = await ModuleRegistry.at(config.contracts.ModuleRegistry);
  const MultiSigWrapper = await MultiSig.at(config.contracts.MultiSigWallet);
  const multisigExecutor = new MultisigExecutor(MultiSigWrapper, deploymentAccount, config.multisig.autosign);

  // //////////////////////////////////
  // Deploy modules
  // //////////////////////////////////

  console.log("Deploying modules");

  // Deploy ArgentModule
  const ArgentModuleWrapper = await ArgentModule.new(
    config.contracts.ModuleRegistry,
    config.modules.GuardianStorage,
    config.modules.TransferStorage,
    config.contracts.DappRegistry,
    config.defi.uniswap.v2Router,
    config.settings.securityPeriod || 0,
    config.settings.securityWindow || 0,
    config.settings.recoveryPeriod || 0,
    config.settings.lockPeriod || 0);

  console.log(`Deployed ArgentModule at ${ArgentModuleWrapper.address}`);

  newModuleWrappers.push(ArgentModuleWrapper);

  // /////////////////////////////////////////////////
  // Update config and Upload ABIs
  // /////////////////////////////////////////////////

  configurator.updateModuleAddresses({
    ArgentModule: ArgentModuleWrapper.address,
  });

  const gitHash = childProcess.execSync("git rev-parse HEAD").toString("utf8").replace(/\n$/, "");
  configurator.updateGitHash(gitHash);

  console.log("Saving new config");
  await configurator.save();

  console.log("Uploading ABIs");
  await Promise.all([
    abiUploader.upload(ArgentModuleWrapper, "modules"),
  ]);

  // //////////////////////////////////
  // Register new modules
  // //////////////////////////////////

  for (let idx = 0; idx < newModuleWrappers.length; idx += 1) {
    const wrapper = newModuleWrappers[idx];
    console.log(`Registering module ${wrapper.constructor.contractName}`);
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [wrapper.address, utils.asciiToBytes32(wrapper.constructor.contractName)]);
  }

  // //////////////////////////////////
  // Deploy and Register upgraders
  // //////////////////////////////////

  let fingerprint;
  console.log(`Loading last ${BACKWARD_COMPATIBILITY} versions`);
  const versions = await versionUploader.load(BACKWARD_COMPATIBILITY);
  for (let idx = 0; idx < versions.length; idx += 1) {
    const version = versions[idx];
    let toAdd; let toRemove;
    if (idx === 0) {
      const moduleNamesToRemove = MODULES_TO_DISABLE.concat(MODULES_TO_ENABLE);
      toRemove = version.modules.filter((module) => moduleNamesToRemove.includes(module.name));
      toAdd = newModuleWrappers.map((wrapper) => ({
        address: wrapper.address,
        name: wrapper.constructor.contractName,
      }));
      const toKeep = version.modules.filter((module) => !moduleNamesToRemove.includes(module.name));
      const modulesInNewVersion = toKeep.concat(toAdd);
      fingerprint = utils.versionFingerprint(modulesInNewVersion);
      newVersion.version = semver.lt(version.version, TARGET_VERSION) ? TARGET_VERSION : semver.inc(version.version, "patch");
      newVersion.createdAt = Math.floor((new Date()).getTime() / 1000);
      newVersion.modules = modulesInNewVersion;
      newVersion.fingerprint = fingerprint;
    } else {
      // add all modules present in newVersion that are not present in version
      toAdd = newVersion.modules.filter((module) => !version.modules.map((m) => m.address).includes(module.address));
      // remove all modules from version that are no longer present in newVersion
      toRemove = version.modules.filter((module) => !newVersion.modules.map((m) => m.address).includes(module.address));
    }

    const upgraderName = `${version.fingerprint}_${fingerprint}`;

    console.log(`Deploying upgrader ${upgraderName}`);
    const UpgraderWrapper = await Upgrader.new(
      config.contracts.ModuleRegistry,
      toRemove.map((module) => module.address),
      toAdd.map((module) => module.address)
    );

    console.log(`Registering ${upgraderName} as a module`);
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerModule",
      [UpgraderWrapper.address, utils.asciiToBytes32(upgraderName)]);

    console.log(`Registering ${upgraderName} as an upgrader`);
    await multisigExecutor.executeCall(ModuleRegistryWrapper, "registerUpgrader",
      [UpgraderWrapper.address, utils.asciiToBytes32(upgraderName)]);
  }

  // //////////////////////////////////
  // Upload Version
  // //////////////////////////////////

  await versionUploader.upload(newVersion);
};

// For truffle exec
module.exports = (cb) => main().then(cb).catch(cb);
