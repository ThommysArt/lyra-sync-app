/**
 * Dev launcher: compile main (with variant baked in), then spawn Electron.
 *
 * Prerequisites: `pnpm run dev:web` on :3001 (or set LYRA_WEB_URL).
 *
 * Variants (side-by-side):
 *   LYRA_VARIANT=development  → Lyra Dev     :53317  (default for `pnpm dev`)
 *   LYRA_VARIANT=preview      → Lyra Preview :53327
 *   LYRA_VARIANT=production   → Lyra         :53337
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { buildElectronMain } from "./build-electron";
import {
  resolveDesktopVariant,
  variantAppName,
  variantDefaultPort,
  variantDeviceName,
  variantDesktopEntry,
  variantSlug,
} from "./variant";

const require = createRequire(import.meta.url);
const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Linux Chromium needs chrome-sandbox owned by root mode 4755.
 * In monorepos / user-writable node_modules that is rarely true, and Electron
 * aborts instead of falling back. Use --no-sandbox for local dev in that case.
 * Packaged AppImages ship a correct sandbox layout.
 */
function needsNoSandbox(electronBin: string): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.ELECTRON_DISABLE_SANDBOX === "0") return false;
  if (process.env.ELECTRON_DISABLE_SANDBOX === "1") return true;

  try {
    const electronRoot = path.dirname(electronBin);
    const candidates = [
      path.join(electronRoot, "chrome-sandbox"),
      path.join(electronRoot, "chrome_sandbox"),
      path.join(electronRoot, "dist", "chrome-sandbox"),
    ];
    for (const sandbox of candidates) {
      if (!existsSync(sandbox)) continue;
      const st = statSync(sandbox);
      const mode = st.mode & 0o7777;
      const isSetuidRoot = st.uid === 0 && (mode & 0o4000) !== 0;
      return !isSetuidRoot;
    }
    // No chrome-sandbox found next to binary — disable sandbox for dev
    return true;
  } catch {
    return true;
  }
}

async function main() {
  // Default local `pnpm dev` to development so it doesn't collide with a packaged prod AppImage
  if (!process.env.LYRA_VARIANT && !process.env.APP_VARIANT) {
    process.env.LYRA_VARIANT = "development";
  }
  const variant = resolveDesktopVariant(process.env.LYRA_VARIANT ?? process.env.APP_VARIANT);
  process.env.LYRA_VARIANT = variant;

  if (!process.env.LYRA_PORT) {
    process.env.LYRA_PORT = String(variantDefaultPort(variant));
  }
  if (!process.env.LYRA_NAME) {
    process.env.LYRA_NAME = variantDeviceName(variant);
  }

  await buildElectronMain();

  let electronBin: string;
  try {
    electronBin = require("electron") as string;
  } catch {
    console.error("electron package not installed. Run pnpm install in apps/desktop.");
    process.exit(1);
  }

  // Chromium flags MUST come before the app path.
  const args: string[] = [];
  const noSandbox = needsNoSandbox(electronBin);
  if (noSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
    console.warn(
      "[lyra desktop] Linux chrome-sandbox is not root/setuid — launching with --no-sandbox (dev only).",
    );
  }
  args.push(".");

  const desktop = variantDesktopEntry(variant);

  // Parent shells (agents, CI wrappers) sometimes set ELECTRON_RUN_AS_NODE=1 which
  // makes the Electron binary behave as plain Node — strip it so the GUI shell runs.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LYRA_VARIANT: variant,
    APP_VARIANT: variant,
    LYRA_PORT: process.env.LYRA_PORT,
    LYRA_NAME: process.env.LYRA_NAME,
    LYRA_WEB_URL: process.env.LYRA_WEB_URL ?? "http://localhost:3001",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    // GNOME/KDE: resolve Icon= from per-variant .desktop
    CHROME_DESKTOP: desktop.fileName,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (noSandbox) {
    env.ELECTRON_DISABLE_SANDBOX = "1";
  }

  console.log(
    `[lyra desktop] starting ${variantAppName(variant)} (${variantSlug(variant)}) · peer :${env.LYRA_PORT}`,
  );

  const child = spawn(electronBin, args, {
    cwd: appRoot,
    stdio: "inherit",
    env,
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
