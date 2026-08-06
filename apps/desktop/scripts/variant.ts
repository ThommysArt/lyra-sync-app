export type Variant = "development" | "preview" | "production";

export function getVariant(): Variant {
  const v = process.env["LYRA_VARIANT"] as Variant | undefined;
  if (v === "preview" || v === "production") return v;
  return "development";
}

export function variantPort(v: Variant): number {
  switch (v) {
    case "development":
      return 53317;
    case "preview":
      return 53327;
    case "production":
      return 53337;
    default:
      return 53317;
  }
}

export function variantAppId(v: Variant): string {
  if (v === "production") return "app.lyra.desktop";
  return `app.lyra.desktop.${v}`;
}

export function variantUserDataSuffix(v: Variant): string {
  if (v === "production") return "";
  return `-${v}`;
}
