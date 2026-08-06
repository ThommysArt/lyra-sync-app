import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { getVariant, variantPort } from "./variant.js";

const variant = getVariant();
const port = variantPort(variant);

console.log(`[build-electron] variant=${variant} port=${port}`);

function run(cmd: string, args: string[]): void {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const cwd = path.resolve(import.meta.dirname ?? ".", "..");
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd });
  if (res.status !== 0) throw new Error(`command failed ${res.status}: ${cmd} ${args.join(" ")}`);
}

// 1) build web
console.log("[build-electron] building web...");
run("pnpm", ["--filter", "web", "build"]);

// 2) compile electron main + scripts
console.log("[build-electron] tsc electron...");
run("npx", ["tsc", "-p", "tsconfig.json", "--outDir", "dist-electron"]);

// 3) ensure resources dir exists
import { mkdirSync, existsSync } from "node:fs";
const resDir = path.resolve(import.meta.dirname ?? ".", "../resources");
if (!existsSync(resDir)) mkdirSync(resDir, { recursive: true });
if (!existsSync(path.join(resDir, "icon.png"))) {
  console.warn("[build-electron] resources/icon.png missing — using placeholder");
}

console.log("[build-electron] done. Next: pnpm --filter desktop dist[:dev|:preview|:prod]");
