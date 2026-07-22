import type { ConfigContext, ExpoConfig } from "expo/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * App variants (side-by-side installable):
 *   APP_VARIANT=development → Lyra Dev     · app.lyra.sync.dev
 *   APP_VARIANT=preview     → Lyra Preview · app.lyra.sync.preview
 *   APP_VARIANT=production  → Lyra         · app.lyra.sync  (default)
 *
 * Version is owned by package.json ("version") so APK labels and the store
 * version stay in one place. Bump package.json (e.g. 0.2.3 → 0.2.4) before release.
 */

export type AppVariant = "development" | "preview" | "production";

function readPackageVersion(): string {
  try {
    // Expo evaluates config with cwd = apps/native
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
  } catch {
    // fall through
  }
  try {
    // Fallback when cwd is monorepo root
    const raw = readFileSync(join(process.cwd(), "apps/native/package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
  } catch {
    // fall through
  }
  return "0.2.3";
}

/** 0.2.3 → 2003 (major*1_000_000 + minor*1_000 + patch) */
export function versionToCode(version: string): number {
  const [maj = "0", min = "0", pat = "0"] = version.split(".");
  const major = Number.parseInt(maj, 10) || 0;
  const minor = Number.parseInt(min, 10) || 0;
  const patch = Number.parseInt(pat.split("-")[0] ?? "0", 10) || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function resolveVariant(raw?: string | null): AppVariant {
  const v = (raw ?? process.env.APP_VARIANT ?? "production").toLowerCase().trim();
  if (v === "development" || v === "dev") return "development";
  if (v === "preview" || v === "pre") return "preview";
  return "production";
}

export function variantPackageId(variant: AppVariant): string {
  switch (variant) {
    case "development":
      return "app.lyra.sync.dev";
    case "preview":
      return "app.lyra.sync.preview";
    default:
      return "app.lyra.sync";
  }
}

export function variantAppName(variant: AppVariant): string {
  switch (variant) {
    case "development":
      return "Lyra Dev";
    case "preview":
      return "Lyra Preview";
    default:
      return "Lyra";
  }
}

export function variantScheme(variant: AppVariant): string {
  switch (variant) {
    case "development":
      return "lyra-dev";
    case "preview":
      return "lyra-preview";
    default:
      return "lyra";
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = resolveVariant(process.env.APP_VARIANT);
  const version = readPackageVersion();
  const versionCode = versionToCode(version);
  const packageId = variantPackageId(variant);
  const name = variantAppName(variant);
  const scheme = variantScheme(variant);

  return {
    ...config,
    name,
    slug: "lyra",
    version,
    scheme,
    userInterfaceStyle: "automatic",
    orientation: "default",
    icon: "./assets/images/icon.png",
    owner: "thommysart24",
    splash: {
      image: "./assets/images/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#0B0F17",
      dark: {
        image: "./assets/images/splash-icon.png",
        resizeMode: "contain",
        backgroundColor: "#0B0F17",
      },
    },
    androidStatusBar: {
      backgroundColor: "#0B0F17",
      barStyle: "light-content",
    },
    web: {
      bundler: "metro",
      favicon: "./assets/images/favicon.png",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: packageId,
      infoPlist: {
        NSCameraUsageDescription:
          "Allow Lyra to access your camera to scan pairing QR codes.",
        NSLocalNetworkUsageDescription:
          "Lyra discovers and connects to your other devices on the local network.",
        NSBonjourServices: ["_lyra._tcp"],
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true,
          NSAllowsArbitraryLoads: true,
        },
        CFBundleDisplayName: name,
      },
    },
    android: {
      package: packageId,
      versionCode,
      adaptiveIcon: {
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      usesCleartextTraffic: true,
      permissions: [
        "android.permission.CAMERA",
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_MULTICAST_STATE",
      ],
    },
    plugins: [
      "expo-font",
      [
        "expo-secure-store",
        {
          configureAndroidBackup: true,
          faceIDPermission: "Allow Lyra to use Face ID to protect device secrets.",
        },
      ],
      "expo-document-picker",
      [
        "expo-camera",
        {
          cameraPermission:
            "Allow Lyra to access your camera to scan pairing QR codes.",
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        "expo-splash-screen",
        {
          backgroundColor: "#0B0F17",
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
        },
      ],
      "./plugins/with-clipboard-accessibility",
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      eas: {
        projectId: "5440becf-0777-4d91-be3b-88ad7f271d5f",
      },
      appVariant: variant,
      appVersion: version,
      appVersionCode: versionCode,
    },
  };
};
