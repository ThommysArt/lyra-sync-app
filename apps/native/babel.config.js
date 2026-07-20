module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // Must be listed last — required for reanimated/worklets on native.
      "react-native-reanimated/plugin",
    ],
  };
};
