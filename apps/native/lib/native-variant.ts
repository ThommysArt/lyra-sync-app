/**
 * Native app variant → default peer listen port.
 * Keeps dev/preview/prod isolated so `pnpm dev` can run desktop + mobile
 * side-by-side without EADDRINUSE races. Desktop uses 53317/53327/53337,
 * native offsets by +2.
 */
export type NativeVariant = "development" | "preview" | "production";

export function resolveNativeVariant(raw?: string | null): NativeVariant {
  let envVariant: string | undefined;
  // Runtime on device: Constants.expoConfig.extra.appVariant (set by app.config.ts)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require("expo-constants").default as {
      expoConfig?: { extra?: { appVariant?: string } };
      manifest?: { extra?: { appVariant?: string } };
    };
    envVariant =
      Constants?.expoConfig?.extra?.appVariant ??
      Constants?.manifest?.extra?.appVariant;
  } catch {
    // not in Expo runtime (e.g. Node / web)
  }
  const v = (
    raw ??
    process.env.APP_VARIANT ??
    process.env.EXPO_PUBLIC_APP_VARIANT ??
    envVariant ??
    "production"
  )
    .toLowerCase()
    .trim();
  if (v === "development" || v === "dev") return "development";
  if (v === "preview" || v === "pre") return "preview";
  return "production";
}

/**
 * Resolve native default port, honoring LYRA_PORT / EXPO_PUBLIC_LYRA_PORT env
 * when explicitly set (for `pnpm dev` with separate mobile/desktop peers).
 */
export function nativePreferredPortFromEnv(): number | null {
  const raw =
    process.env.EXPO_PUBLIC_LYRA_PORT ??
    process.env.LYRA_PORT ??
    (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>)["EXPO_PUBLIC_LYRA_PORT"] : undefined);
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  return null;
}

/**
 * Default peer listen port for the native app. Desktop is 53317/53327/53337,
 * native is +2 so both can bind on the same host when run via `pnpm dev`
 * (desktop Electron + mobile peer server or CLI peer stubs).
 */
export function nativeVariantDefaultPort(variant: NativeVariant): number {
  switch (variant) {
    case "development":
      return 53319;
    case "preview":
      return 53329;
    default:
      return 53339;
  }
}

/** Variant-aware default port from current env (APP_VARIANT / EXPO_PUBLIC_APP_VARIANT). */
export function nativeDefaultPortFromEnv(): number {
  return nativeVariantDefaultPort(resolveNativeVariant());
}
