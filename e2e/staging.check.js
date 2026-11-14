import { test, expect } from "@playwright/test";

// reader staging gate: the staging preview must load, show the STAGING
// banner, and render the app shell without console errors.
// Like xuexi's check, this does not assert which GAS deployment was
// called; until reader-gas-staging exists the staging preview may read
// the production API. Login is not performed here (read-only check):
// with no session the sign-in gate is the expected first screen.
// v2 note: the timeline UI (view tabs すべて/未読 only, no スター tab,
// and the header 更新 button) only exists after login, so its shape is
// pinned by unit tests; here we only assert the signed-out shell has no
// star affordance left.
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
  await expect(page.getByText("Googleログインが必要です")).toBeVisible();
  await expect(page.getByText("スター", { exact: true })).toHaveCount(0);
  await expect(page.locator(".star-btn")).toHaveCount(0);
  await expect(page.locator(".view-tabs")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Header layout guard: the PR #26 regression wrapped the brand name
// vertically on phone widths while its text stayed "リーダー", so the
// text assertion above cannot catch that class of breakage. Pin the
// rendered height instead (single line at 390px wide is ~21px).
test("reader staging header keeps the brand on one line at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const resp = await page.goto("/reader/staging/");
  expect(resp.status()).toBe(200);
  const box = await page.locator(".brand-name").boundingBox();
  expect(box).not.toBeNull();
  expect(box.height).toBeLessThan(30);
});

// Invalid share link: the app must surface the invalid-link message and
// strip the token from the URL (history.replaceState) even though the
// exchange fails. This path needs no valid token, so it can run in the
// read-only gate.
test("reader staging rejects an invalid share link and strips the hash", async ({ page }) => {
  await page.goto("/reader/staging/#share=invalid-token");
  await expect(page.getByText("共有リンクが無効か、期限が切れています")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("");
});
