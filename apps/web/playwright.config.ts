import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LYRA_WEB_PORT ?? 3001);
const baseURL = process.env.LYRA_WEB_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.LYRA_SKIP_WEBSERVER
    ? undefined
    : {
        command: `pnpm exec vite dev --port ${port} --strictPort --host 127.0.0.1`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Ensure demo mesh peers/transfers for smoke assertions in CI
          VITE_LYRA_SEED_DEMO: process.env.VITE_LYRA_SEED_DEMO ?? "1",
        },
      },
});
