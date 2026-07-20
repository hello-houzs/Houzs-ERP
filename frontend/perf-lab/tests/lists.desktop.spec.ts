import { expect, test } from "@playwright/test";
import { expectBounded, nextFrames, scrollWindowToRealEnd } from "./geometry.helpers";

test("DataTable keeps 10k desktop rows windowed through the browser's real scroll clamp", async ({ page }) => {
  await page.goto("/?scenario=data-table-desktop");
  const rows = page.locator("tr[data-vrow]");
  await expect(rows.first()).toContainText("Order 00001");
  await expectBounded(rows, 60);
  await expect(page.getByText("Order 10000", { exact: true })).toHaveCount(0);

  await scrollWindowToRealEnd(page);

  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(rows, 60);
});

test("DataGrid keeps 10k rows windowed at its real internal scroll limit", async ({ page }) => {
  await page.goto("/?scenario=data-grid");
  const rows = page.locator("tr[data-vrow]");
  const scroller = page.locator('[data-scenario="data-grid"] table').locator("..");
  await expect(rows.first()).toContainText("Order 00001");
  await expectBounded(rows, 60);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await nextFrames(page, 3);

  const geometry = await scroller.evaluate((element) => ({
    actual: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
  }));
  expect(Math.abs(geometry.actual - geometry.maximum)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Order 10000", { exact: true })).toBeVisible();
  await expect(page.getByText("Order 00001", { exact: true })).toHaveCount(0);
  await expectBounded(rows, 60);
});

test("controlled DataTable hides settled A rows while A1 is pending", async ({ page }) => {
  await page.goto("/?scenario=search");
  const host = page.locator('[data-scenario="search"]');
  const search = page.getByRole("textbox");
  await expect(search).toHaveValue("A");
  await expect(page.getByText("A only result", { exact: true })).toBeVisible();

  await search.fill("A1");
  await expect(search).toHaveValue("A1");
  await expect(host).toHaveAttribute("data-query", "A1");
  await expect(host).toHaveAttribute("data-result-query", "A");
  await expect(host).toHaveAttribute("data-searching", "true");
  await expect(page.getByRole("status")).toContainText("Searching");
  await expect(page.getByText("A only result", { exact: true })).toHaveCount(0);
  await expect(page.getByText("A1 exact result", { exact: true })).toHaveCount(0);

  await page.locator("[data-settle-search]").click();
  await nextFrames(page, 1);

  await expect(host).toHaveAttribute("data-result-query", "A1");
  await expect(host).toHaveAttribute("data-searching", "false");
  await expect(page.getByText("A1 exact result", { exact: true })).toBeVisible();
  await expect(page.getByText("A only result", { exact: true })).toHaveCount(0);
});
