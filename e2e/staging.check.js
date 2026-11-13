import { test, expect } from "@playwright/test";

// reader staging gate: the staging preview must load, show the STAGING
// banner, and render the app shell without console errors.
// Like xuexi's check, this does not assert which GAS deployment was
// called; until reader-gas-staging exists the staging preview may read
// the production API. Login is not performed here (read-only check):
// with no session the sign-in gate is the expected first screen.
test("reader staging page loads with banner and sign-in gate", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  const resp = await page.goto("/reader/staging/");
  expect(resp.status()).toBe(200);
  await expect(page.getByText("STAGING")).toBeVisible();
  await expect(page.locator(".brand-name")).toHaveText("リーダー");
  await expect(page.getByRole("heading", { name: "リーダー" })).toBeVisible();
  await expect(page.getByText("Googleログインが必要です")).toBeVisible();
  expect(errors).toEqual([]);
});
