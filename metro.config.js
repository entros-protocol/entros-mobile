// Expo Metro config for the bundled proving key and vendored Mopro package.
//
// The zkey extension lets Asset resolve the Groth16 proving key. The watch
// folder keeps edits to the file-linked Mopro package visible during development.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push("zkey");

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, "MoproReactNativeBindings"),
];

module.exports = config;
