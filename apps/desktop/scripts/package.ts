/**
 * Package Electron with a desktop variant + versioned artifact names.
 *
 *   LYRA_VARIANT=development tsx scripts/package.ts --dir
 *   LYRA_VARIANT=preview tsx scripts/package.ts
 *   LYRA_VARIANT=production tsx scripts/package.ts
 *
 * Outputs (example, version 0.2.3):
 *   release/Lyra-0.2.3-dev.AppImage
 *   release/Lyra-0.2.3-preview.AppImage
 *   release/Lyra-0.2.3-prod.AppImage
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDesktopVariant,
  variantAppId,
  variantAppName,
  variantDesktopEntry,
  variantExecutableName,
  variantSlug,
} from "./variant";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const version = pkg.version || "0.0.0";
const variant = resolveDesktopVariant(process.env.LYRA_VARIANT ?? process.env.APP_VARIANT);
const slug = variantSlug(variant);
const productName = variantAppName(variant);
const appId = variantAppId(variant);
const executableName = variantExecutableName(variant);
const desktop = variantDesktopEntry(variant);

const dirOnly = process.argv.includes("--dir");
const extraArgs = process.argv.slice(2).filter((a) => a !== "--dir");

process.env.LYRA_VARIANT = variant;
process.env.APP_VARIANT = variant;

console.log(
  `\n[lyra desktop] Packaging ${productName} · ${appId} · v${version} · variant=${variant}\n`,
);

// Bundle main with variant baked in
const build = spawnSync("pnpm", ["exec", "tsx", "scripts/build-electron.ts"], {
  cwd: appRoot,
  env: { ...process.env, LYRA_VARIANT: variant },
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) process.exit(build.status ?? 1);

// electron-builder config overlay (written so CLI and CI both pick it up)
const builderConfig = {
  appId,
  productName,
  // electron-builder token: ${version} ${ext} — we also stamp variant in the name
  artifactName: `Lyra-\${version}-${slug}.\${ext}`,
  directories: {
    output: "release",
  },
  files: [
    "dist-electron/**/*",
    "resources/icon.png",
    "resources/icons/**/*",
    "package.json",
  ],
  extraResources: [
    { from: "resources/icon.png", to: "icon.png" },
    {
      from: "../web/dist",
      to: "web-dist",
      filter: ["**/*"],
    },
  ],
  linux: {
    target: dirOnly ? ["dir"] : ["AppImage", "dir"],
    category: "Network",
    executableName,
    icon: "resources/icons",
    desktop: {
      Name: productName,
      Comment: "Privacy-first device network — clipboard, files, and remote browse.",
      StartupWMClass: desktop.wmClass,
    },
  },
  mac: {
    target: dirOnly ? ["dir"] : ["dmg", "dir"],
    category: "public.app-category.utilities",
    icon: "resources/icon.png",
  },
  win: {
    target: dirOnly ? ["dir"] : ["nsis", "dir"],
    icon: "resources/icon.png",
  },
  // Publish nothing by default
  publish: null,
};

const confPath = join(appRoot, "electron-builder.variant.json");
writeFileSync(confPath, JSON.stringify(builderConfig, null, 2), "utf8");

const webDist = join(appRoot, "../web/dist/index.html");
if (!existsSync(webDist)) {
  console.warn(
    "[lyra desktop] apps/web/dist missing — run `pnpm --filter web build` first for a full UI package.",
  );
}

const ebArgs = ["exec", "electron-builder", "--config", confPath, ...extraArgs];
if (dirOnly && !extraArgs.some((a) => a === "--dir")) {
  ebArgs.push("--dir");
}

const pack = spawnSync("pnpm", ebArgs, {
  cwd: appRoot,
  env: { ...process.env, LYRA_VARIANT: variant },
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (pack.status !== 0) process.exit(pack.status ?? 1);

// Convenience copy list
const releaseDir = join(appRoot, "release");
mkdirSync(releaseDir, { recursive: true });
console.log(`\n[lyra desktop] Done · look for Lyra-${version}-${slug}.* under release/\n`);
