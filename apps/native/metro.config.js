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

// Prefer app node_modules, then monorepo root.
// Hierarchical lookup stays on so Expo can resolve expo-router from apps/native.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

/**
 * Force a single React / RN instance. Workspace packages (e.g. @lyra-sync-app/hooks)
 * can otherwise resolve a different react version from their own node_modules
 * (Invalid hook call / hard crash on native).
 */
const singletonModules = [
  "react",
  "react-dom",
  "react-native",
  "react-native-reanimated",
  "react-native-worklets",
  "react-native-gesture-handler",
  "react-native-safe-area-context",
  "react-native-screens",
  "react-native-svg",
  "scheduler",
];

const singletonPaths = Object.fromEntries(
  singletonModules.map((name) => [
    name,
    path.resolve(projectRoot, "node_modules", name),
  ]),
);

config.resolver.extraNodeModules = singletonPaths;

// Hard-pin singleton modules even when a workspace package has its own copy.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (singletonPaths[moduleName]) {
    return {
      filePath: require.resolve(moduleName, {
        paths: [path.resolve(projectRoot, "node_modules")],
      }),
      type: "sourceFile",
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

const uniwindConfig = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});

module.exports = uniwindConfig;
