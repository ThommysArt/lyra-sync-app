import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { getVariant, variantPort } from "./variant.js";

const variant = getVariant();
const port = variantPort(variant);

console.log(`[build-electron] variant=${variant} port=${port}`);

function run(cmd: string, args: string[]): void {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd: path.resolve(import.meta.dirname ?? ".", "..") });
  if (res.status !== 0) {
    console.warn(`command failed with ${res.status}: ${cmd} ${args.join(" ")}`);
  }
}

// compile electron main
run("npx", ["tsc", "-p", "tsconfig.json", "--outDir", "dist-electron"]);

console.log("[build-electron] done. Ensure web/dist exists for extraResources.");
