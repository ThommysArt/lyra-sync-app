import { spawn } from "node:child_process";
import { variantPort, getVariant } from "./variant.js";

const variant = getVariant();
const port = variantPort(variant);
const webUrl = process.env["LYRA_WEB_URL"] ?? "http://localhost:3001";

console.log(`[lyra desktop dev] variant=${variant} port=${port} webUrl=${webUrl}`);

// spawn vite for web if available (best-effort)
function spawnWeb(): void {
  try {
    const child = spawn("pnpm", ["--filter", "web", "dev"], {
      stdio: "inherit",
      env: { ...process.env, VITE_PORT: "3001" },
      shell: true,
    });
    child.on("exit", (code) => console.log(`[web] exited ${code}`));
  } catch (err) {
    console.warn("[dev] failed to spawn web vite:", String(err));
  }
}

function spawnElectron(): void {
  const env = { ...process.env, LYRA_VARIANT: variant, LYRA_WEB_URL: webUrl, LYRA_PORT: String(port) };
  try {
    const child = spawn("npx", ["electron", "."], { stdio: "inherit", env, shell: true });
    child.on("exit", (code) => {
      console.log(`[electron] exited ${code}`);
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.warn("[dev] failed to spawn electron:", String(err));
  }
}

spawnWeb();
spawnElectron();
