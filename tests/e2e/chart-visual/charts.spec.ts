import { expect, test } from "@playwright/test";

test.describe("TanStack Charts consumer visuals", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} theme renders all five migrated consumers`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/?theme=${theme}`);

      const gallery = page.getByRole("main", {
        name: "Chart consumer visual regression gallery",
      });
      await expect(gallery).toBeVisible();
      await expect(gallery.locator("[data-consumer]")).toHaveCount(5);
      await expect(gallery.locator('svg[role="img"]')).toHaveCount(6);
      await expect(gallery).toHaveScreenshot(`chart-consumers-${theme}.png`, {
        animations: "disabled",
      });
    });
  }
});
