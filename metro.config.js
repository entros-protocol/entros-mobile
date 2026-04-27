// Vanilla Expo Metro config. The UI scaffold has no polyfill needs.
//
// When Tier A wires @solana/web3.js + snarkjs into the runtime, this file gets
// extraNodeModules entries for `crypto` and `stream` (via expo-crypto and
// react-native-url-polyfill respectively).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
