/**
 * Desktop app variants — side-by-side install / run (mirrors native APP_VARIANT).
 *
 *   development → Lyra Dev     · app.lyra.desktop.dev     · peer :53317
 *   preview     → Lyra Preview · app.lyra.desktop.preview · peer :53327
 *   production  → Lyra         · app.lyra.desktop         · peer :53337
 */

export type DesktopVariant = "development" | "preview" | "production";

export function resolveDesktopVariant(raw?: string | null): DesktopVariant {
  const v = (raw ?? process.env.LYRA_VARIANT ?? process.env.APP_VARIANT ?? "production")
    .toLowerCase()
    .trim();
  if (v === "development" || v === "dev") return "development";
  if (v === "preview" || v === "pre") return "preview";
  return "production";
}

export function variantSlug(variant: DesktopVariant): string {
  if (variant === "development") return "dev";
  if (variant === "preview") return "preview";
  return "prod";
}

export function variantAppName(variant: DesktopVariant): string {
  switch (variant) {
    case "development":
      return "Lyra Dev";
    case "preview":
      return "Lyra Preview";
    default:
      return "Lyra";
  }
}

/** Electron / Windows AppUserModelId / electron-builder appId */
export function variantAppId(variant: DesktopVariant): string {
  switch (variant) {
    case "development":
      return "app.lyra.desktop.dev";
    case "preview":
      return "app.lyra.desktop.preview";
    default:
      return "app.lyra.desktop";
  }
}

/** userData folder under appData (isolated identity + localStorage) */
export function variantUserDataDir(variant: DesktopVariant): string {
  switch (variant) {
    case "development":
      return "lyra-desktop-dev";
    case "preview":
      return "lyra-desktop-preview";
    default:
      return "lyra-desktop";
  }
}

/** Default peer listen port so variants can run at the same time */
export function variantDefaultPort(variant: DesktopVariant): number {
  switch (variant) {
    case "development":
      return 53317;
    case "preview":
      return 53327;
    default:
      return 53337;
  }
}

/** Device display name when identity is first created */
export function variantDeviceName(variant: DesktopVariant): string {
  switch (variant) {
    case "development":
      return "Lyra Desktop (Dev)";
    case "preview":
      return "Lyra Desktop (Preview)";
    default:
      return "Lyra Desktop";
  }
}

/** Linux .desktop + CHROME_DESKTOP / StartupWMClass */
export function variantDesktopEntry(variant: DesktopVariant): {
  fileName: string;
  wmClass: string;
  iconName: string;
} {
  switch (variant) {
    case "development":
      return { fileName: "lyra-dev.desktop", wmClass: "Lyra Dev", iconName: "lyra-dev" };
    case "preview":
      return {
        fileName: "lyra-preview.desktop",
        wmClass: "Lyra Preview",
        iconName: "lyra-preview",
      };
    default:
      return { fileName: "lyra.desktop", wmClass: "Lyra", iconName: "lyra" };
  }
}

/** Linux executable / AppImage base name */
export function variantExecutableName(variant: DesktopVariant): string {
  switch (variant) {
    case "development":
      return "lyra-dev";
    case "preview":
      return "lyra-preview";
    default:
      return "lyra";
  }
}

export function versionToCode(version: string): number {
  const [maj = "0", min = "0", pat = "0"] = version.split(".");
  const major = Number.parseInt(maj, 10) || 0;
  const minor = Number.parseInt(min, 10) || 0;
  const patch = Number.parseInt(pat.split("-")[0] ?? "0", 10) || 0;
  return major * 1_000_000 + minor * 1_000 + patch;
}
