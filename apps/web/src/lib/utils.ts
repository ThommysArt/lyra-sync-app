export { cn } from "@lyra-sync-app/ui/lib/utils";

export function deviceIconName(platform: string, type: string): string {
  if (type === "mobile") {
    return platform === "ios" ? "smartphone" : "smartphone";
  }
  if (platform === "macos") return "laptop";
  if (platform === "windows" || platform === "linux") return "monitor";
  return "monitor";
}
