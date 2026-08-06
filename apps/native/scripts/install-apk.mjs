#!/usr/bin/env node
/**
 * Install the versioned APK for a variant (prefers dist/, falls back to gradle outputs).
 *
 *   APP_VARIANT=development node scripts/install-apk.mjs
 *   node scripts/install-apk.mjs preview
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nativeRoot = resolve(__dirname, "..");
const distDir = join(nativeRoot, "dist");

function resolveVariant() {
  const arg = (process.argv[2] || process.env.APP_VARIANT || "development").toLowerCase();
  if (arg === "development" || arg === "dev") return "development";
  if (arg === "preview" || arg === "pre") return "preview";
  if (arg === "production" || arg === "prod") return "production";
  return "development";
}

function variantSlug(variant) {
  if (variant === "development") return "dev";
  if (variant === "preview") return "preview";
  return "prod";
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8"));
  return pkg.version || "0.0.0";
}

function newest(paths) {
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length === 0) return null;
  existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return existing[0];
}

const variant = resolveVariant();
const slug = variantSlug(variant);
const version = readVersion();

const candidates = [
  join(distDir, `lyra-${version}-${slug}.apk`),
  // any versioned match for this slug
  ...(existsSync(distDir)
    ? readdirSync(distDir)
        .filter((f) => f.startsWith("lyra-") && f.endsWith(`-${slug}.apk`))
        .map((f) => join(distDir, f))
    : []),
  join(
    nativeRoot,
    "android/app/build/outputs/apk",
    slug === "dev" ? "debug/app-debug.apk" : "release/app-release.apk",
  ),
];

const apk = newest(candidates);
if (!apk) {
  console.error(
    `[lyra] No APK for ${variant}. Build first:\n  pnpm run build:${slug === "dev" ? "dev" : "preview"}`,
  );
  process.exit(1);
}

console.log(`[lyra] Installing ${apk}`);
const r = spawnSync("adb", ["install", "-r", apk], { stdio: "inherit" });
process.exit(r.status ?? 1);
