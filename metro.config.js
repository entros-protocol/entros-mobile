// Expo Metro config with three Stage 6 additions:
//
// 1. `zkey` in assetExts — src/proof/assets.ts requires the Groth16 proving
//    key (`assets/circuits/entros_hamming_final.zkey`) via Asset.fromModule
//    so it can be materialized to expo-file-system's documentDirectory.
//    Without this, Metro's resolver throws on the `require(...zkey)` call.
//
// 2. `MoproReactNativeBindings/` watchFolder — the mopro-ffi package is
//    vendored at the project root and linked via `file:MoproReactNativeBindings`
//    in package.json. Metro doesn't follow file: links into watchFolders by
//    default, so dev-time changes to the vendored TS bindings won't trigger
//    fast-refresh without this. Production bundling resolves through
//    node_modules either way; the watchFolder only matters in development.
//
// 3. blockList for `MoproReactNativeBindings/node_modules/**` — the vendored
//    package's package.json declares devDependencies (RN 0.81.4, etc.) that
//    npm may install if anything triggers it. With the watchFolder above,
//    Metro would then walk into RN 0.81.4's source which uses pattern-match
//    syntax our Babel preset can't parse. Block to keep the bundle clean.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push("zkey");

// Mobile Wallet Adapter exposes its native encoding helper through package exports.
config.resolver.unstable_enablePackageExports = true;

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, "MoproReactNativeBindings"),
];

const moproNestedNodeModules = new RegExp(
  `${path.resolve(__dirname, "MoproReactNativeBindings", "node_modules").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*`,
);

config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  moproNestedNodeModules,
];

module.exports = config;
