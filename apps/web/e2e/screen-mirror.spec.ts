import { expect, test } from "@playwright/test";

test.describe("Screen mirror + Tailscale UI", () => {
  test("devices page exposes Tailscale add form", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { name: "Devices", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Add by Tailscale IP")).toBeVisible();
    await expect(page.getByPlaceholder("100.83.145.32")).toBeVisible();

    // Enable Tailscale in settings first so the form unlocks
    await page.goto("/settings");
    await expect(page.getByText("Tailscale support")).toBeVisible();
    const switchBtn = page.getByRole("switch").filter({ has: page.locator("..") });
    // Prefer the switch associated with Tailscale row
    const tailscaleSwitch = page
      .locator("div")
      .filter({ hasText: /^Tailscale support/ })
      .getByRole("switch")
      .first();
    if (await tailscaleSwitch.count()) {
      const checked = await tailscaleSwitch.getAttribute("data-state");
      if (checked !== "checked" && checked !== "on") await tailscaleSwitch.click();
    } else if (await switchBtn.count()) {
      // fallback: last defaults switch is often Tailscale area — use getByText sibling
      await page.getByText("Tailscale support").click();
    }

    await page.goto("/");
    const tsInput = page.getByLabel("Tailscale IP / MagicDNS");
    // If still disabled, force-enable via local storage path is hard — click enable toast path
    if (await tsInput.isDisabled()) {
      await page.goto("/settings");
      const sw = page.locator("label,div").filter({ hasText: "Tailscale support" }).getByRole("switch");
      if (await sw.count()) await sw.first().click();
      await page.goto("/");
    }
    await expect(tsInput).toBeEnabled({ timeout: 10_000 });
    await tsInput.fill("100.83.145.32");
    await page.locator("#ts-name").fill("pixel-ts");
    await page.getByRole("button", { name: "Add Tailscale peer" }).click();
    // Nearby peer should appear (untrusted)
    await expect(page.getByText(/pixel-ts|100\.83\.145\.32/i).first()).toBeVisible({
      timeout: 10_000,
    });

    expect(errors.filter((e) => e.includes("Maximum update depth")).length).toBe(0);
  });

  test("device detail shows screen mirror bezel and preview", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("main").getByRole("heading", { name: "Devices", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Pixel/i).first()).toBeVisible({ timeout: 30_000 });

    // Open Pixel device detail
    const pixelCard = page.locator("a,button").filter({ hasText: /Pixel/i }).first();
    if (await pixelCard.count()) {
      await pixelCard.click();
    } else {
      await page.getByRole("link", { name: /Open/i }).nth(1).click();
    }

    await expect(page.getByText("Screen mirror")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Connection addresses")).toBeVisible();
    await expect(page.getByLabel("Tailscale IP or MagicDNS")).toBeVisible();

    // Opens Simulator-style window; main panel keeps a status thumbnail
    await page.getByRole("button", { name: "Preview (demo frames)" }).click();
    await expect(page.getByRole("button", { name: "Focus mirror window" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: "Stop mirror" })).toBeVisible();

    await page.getByRole("button", { name: "Stop mirror" }).click();
    await expect(page.getByRole("button", { name: "Open mirror window" })).toBeVisible();

    expect(errors.filter((e) => e.includes("Maximum update depth")).length).toBe(0);
  });
});
