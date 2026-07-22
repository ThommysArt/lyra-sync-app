/**
 * Bundle Electron main process into dist-electron/ for packaging and production.
 * Always uses esbuild — the previous tsx-loader stub broke AppImage launches
 * because electron/main.ts is not included in the asar.
 *
 * Bakes LYRA_VARIANT / version so packaged AppImages keep their identity without env.
 */
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

import { resolveDesktopVariant } from "./variant";

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(appRoot, "dist-electron");
const require = createRequire(import.meta.url);

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function buildElectronMain() {
  await mkdir(outDir, { recursive: true });

  const variant = resolveDesktopVariant(process.env.LYRA_VARIANT ?? process.env.APP_VARIANT);
  const version = packageVersion();

  const result = await build({
    entryPoints: [path.join(appRoot, "electron/main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: path.join(outDir, "main.js"),
    external: ["electron"],
    packages: "bundle",
    // Bake variant/version for packaged runs (dev still overrides via real env)
    define: {
      "process.env.LYRA_VARIANT": JSON.stringify(variant),
      "process.env.LYRA_VERSION": JSON.stringify(version),
    },
    // Keep Node built-ins external; bundle workspace packages into the asar entry
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "info",
    metafile: true,
  });

  await writeFile(
    path.join(outDir, "build-info.json"),
    JSON.stringify({ variant, version, builtAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  console.log(`[lyra] electron bundle variant=${variant} version=${version}`);

  const mainJs = await readFile(path.join(outDir, "main.js"), "utf8");
  // Reject the old tsx-loader stub (not esbuild source comments mentioning main.ts)
  if (
    mainJs.includes('from "tsx/esm/api"') ||
    mainJs.includes("from 'tsx/esm/api'") ||
    mainJs.includes('register();\nawait import(new URL("../electron/main.ts"')
  ) {
    throw new Error(
      "dist-electron/main.js looks like a dev loader stub, not a production bundle",
    );
  }
  // mainJs is a string (utf8 read) — size via length, not byteLength
  if (mainJs.length < 10_000) {
    throw new Error(
      `dist-electron/main.js is suspiciously small (${mainJs.length} chars) — bundle failed`,
    );
  }

  await copyFile(
    path.join(appRoot, "electron/preload.cjs"),
    path.join(outDir, "preload.cjs"),
  );

  // Optional size report for CI logs
  const outputs = result.metafile?.outputs ?? {};
  const mainOut = Object.entries(outputs).find(([k]) => k.endsWith("main.js"));
  const bytes = mainOut?.[1]?.bytes ?? mainJs.length;
  console.log(
    `Electron main bundled → dist-electron/main.js (${Math.round(bytes / 1024)} KiB)`,
  );

  // Sanity: esbuild must resolve from package (not optional)
  void require.resolve("esbuild");
}

// CLI: `tsx scripts/build-electron.ts`
const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith("build-electron.ts") ||
    process.argv[1].endsWith("build-electron.js"));

if (isDirect) {
  buildElectronMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}