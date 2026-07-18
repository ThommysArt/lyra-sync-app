/**
 * Prepare dist-electron for Electron main process.
 * Bundling is optional (esbuild); default writes a tsx-loader entry.
 */
import { mkdir, writeFile, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(appRoot, "dist-electron");

async function hasEsbuild(): Promise<boolean> {
  try {
    await access(path.join(appRoot, "node_modules/esbuild/package.json"));
    return true;
  } catch {
    try {
      await access(
        path.join(appRoot, "../../node_modules/esbuild/package.json"),
      );
      return true;
    } catch {
      return false;
    }
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  if (await hasEsbuild()) {
    const { build } = await import("esbuild");
    await build({
      entryPoints: [path.join(appRoot, "electron/main.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: path.join(outDir, "main.js"),
      external: ["electron"],
      packages: "bundle",
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
  } else {
    // Dev-friendly: load TypeScript main via tsx register
    await writeFile(
      path.join(outDir, "main.js"),
      `import { register } from "tsx/esm/api";
register();
await import(new URL("../electron/main.ts", import.meta.url).href);
`,
      "utf8",
    );
  }

  await copyFile(
    path.join(appRoot, "electron/preload.cjs"),
    path.join(outDir, "preload.cjs"),
  );
  console.log("Electron main prepared → dist-electron/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
