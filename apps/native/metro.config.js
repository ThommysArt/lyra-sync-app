const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const { wrapWithReanimatedMetroConfig } = require("react-native-reanimated/metro-config");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Watch monorepo packages so @lyra-sync-app/* changes hot-reload
config.watchFolders = [monorepoRoot];

// Prefer app node_modules, then monorepo root (do NOT disable hierarchical lookup —
// Expo needs to resolve expo-router from apps/native/node_modules).
//
// Do not add a custom resolveRequest / extraNodeModules singleton pin here:
// that pattern caused EAS createBundleReleaseJsAndAssets to fail with
// "Cannot read properties of undefined (reading 'transformFile')".
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

const uniwindConfig = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});

module.exports = uniwindConfig;
