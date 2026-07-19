import { expect, test } from "@playwright/test";

test.describe("Lyra web smoke", () => {
  test("devices shell loads without max-update-depth", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByPlaceholder("Search devices…")).toBeVisible();

    // Seeded demo peers should appear when VITE_LYRA_SEED_DEMO=1 (CI default)
    await expect(page.getByText(/MacBook|Pixel|Office/i).first()).toBeVisible();

    expect(errors.filter((e) => e.includes("Maximum update depth")).length).toBe(0);
  });

  test("settings network card and integrity toggle", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByText("Network", { exact: true })).toBeVisible();
    await expect(page.getByText("Peer server idle")).toBeVisible();
    await expect(page.getByText("Verify transfer integrity")).toBeVisible();
    await expect(page.getByText(/Browser mode/)).toBeVisible();
  });

  test("transfers demo resume creates paused session", async ({ page }) => {
    await page.goto("/transfers");
    await expect(page.getByRole("heading", { name: "Transfers", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Demo resume" }).click();
    await expect(page.getByText(/Resumable from|paused|movie\.mp4/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
