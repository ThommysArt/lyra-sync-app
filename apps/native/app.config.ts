import type { ConfigContext, ExpoConfig } from "expo/config";
import pkg from "./package.json";

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = (process.env.APP_VARIANT ?? process.env.EXPO_PUBLIC_APP_VARIANT ?? "development") as
    | "development"
    | "preview"
    | "production";
  const appId =
    variant === "production" ? "app.lyra.sync" : variant === "preview" ? "app.lyra.sync.preview" : "app.lyra.sync.dev";

  const name = variant === "production" ? "Lyra" : variant === "preview" ? "Lyra (Preview)" : "Lyra (Dev)";

  return {
    ...config,
    name,
    slug: "lyra-sync-app",
    version: pkg.version,
    scheme: "lyra-sync-app",
    ios: {
      ...(config.ios ?? {}),
      bundleIdentifier: appId,
    },
    android: {
      ...(config.android ?? {}),
      package: appId,
    },
    web: {
      ...(config.web ?? {}),
      bundler: "metro",
    },
    plugins: config.plugins ?? ["expo-font"],
    experiments: {
      ...(config.experiments ?? {}),
      typedRoutes: true,
      reactCompiler: true,
    },
  };
};
