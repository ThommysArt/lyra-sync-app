/**
 * Dev launcher: compile main (or use tsx), then spawn Electron pointing at Vite web.
 *
 * Prerequisites: `pnpm run dev:web` on :3001 (or set LYRA_WEB_URL).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  // Build / prepare dist-electron
  await import("./build-electron.ts");

  let electronBin: string;
  try {
    electronBin = require("electron") as string;
  } catch {
    console.error("electron package not installed. Run pnpm install in apps/desktop.");
    process.exit(1);
  }

  const child = spawn(electronBin, ["."], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      LYRA_WEB_URL: process.env.LYRA_WEB_URL ?? "http://localhost:3001",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
