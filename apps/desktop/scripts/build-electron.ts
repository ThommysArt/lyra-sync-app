/**
 * Bundle Electron main process into dist-electron/ for packaging and production.
 * Always uses esbuild — the previous tsx-loader stub broke AppImage launches
 * because electron/main.ts is not included in the asar.
 */
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(appRoot, "dist-electron");
const require = createRequire(import.meta.url);

export async function buildElectronMain() {
  await mkdir(outDir, { recursive: true });

  const result = await build({
    entryPoints: [path.join(appRoot, "electron/main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: path.join(outDir, "main.js"),
    external: ["electron"],
    packages: "bundle",
    // Keep Node built-ins external; bundle workspace packages into the asar entry
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "info",
    metafile: true,
  });

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