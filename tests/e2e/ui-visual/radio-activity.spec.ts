import { expect, test } from "@playwright/test";

const radio = {
  radio_status: "connected",
  startup_policy: "full",
  command_status: "idle",
  radio_generation: 1,
  sequence: 100,
  physical_rf_state: "unavailable",
};
const jobs = Array.from({ length: 50 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  kind: i === 0 ? "radio_stats_sample" : "direct_message",
  state: "completed",
  stage: "finished",
  priority: 10,
  version: 1,
  sequence: 100 - i,
  radio_generation: 1,
  attempt: 1,
  cancellation_requested: false,
  correlation_scope: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:01Z",
  queue_entered_at: "2026-01-01T00:00:00Z",
}));

for (const width of [375, 1280]) {
  test(`history loading, failure, empty and scroll states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let mode = "pending";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/radio/**", async (route) => {
      if (mode === "pending") await pending;
      if (mode === "error") {
        await route.fulfill({
          status: 503,
          json: { detail: "Synthetic unavailable service" },
        });
        return;
      }
      const isJobs = new URL(route.request().url()).pathname.endsWith("/jobs");
      await route.fulfill({
        json: {
          items: mode === "filled" && isJobs ? jobs : [],
          radio,
          snapshot_sequence: 100,
          next_cursor: null,
          has_more: false,
          gap: false,
        },
      });
    });
    await page.goto("/?activity");
    const history = page.getByRole("region", { name: "History", exact: true });
    await expect(history.getByText("Loading history…")).toBeVisible();
    mode = "error";
    release();
    await expect(
      history.getByText("Failed to load job history."),
    ).toBeVisible();
    await expect(history.getByText(/No matching history/)).toHaveCount(0);
    mode = "empty";
    await history.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(history.getByText(/No matching history/)).toBeVisible();
    const list = history.getByRole("group", { name: "Job history list" });
    await expect(list).not.toHaveAttribute("tabindex");

    mode = "filled";
    await page
      .getByRole("button", { name: "Refresh radio activity", exact: true })
      .click();
    await expect(list.getByText("Direct message").first()).toBeVisible();
    await expect(list.getByText("Radio stats sample")).toHaveCount(0);
    await history
      .getByRole("checkbox", { name: "Include routine background jobs" })
      .check();
    await expect(list.getByText("Radio stats sample")).toBeVisible();
    await expect(list).toHaveAttribute("tabindex", "0");
    const dimensions = await list.evaluate((el) => ({
      height: el.clientHeight,
      contentHeight: el.scrollHeight,
      width: el.clientWidth,
      contentWidth: el.scrollWidth,
    }));
    expect(dimensions.height).toBeLessThanOrEqual(416);
    expect(dimensions.contentHeight).toBeGreaterThan(dimensions.height);
    expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width);
    await list.focus();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    // Tab can leave the nested scroll surface; it is not a keyboard focus trap.
    await page.keyboard.press("Tab");
    await expect(list).not.toBeFocused();
    const columns = await history.evaluate(
      (el) =>
        getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ")
          .length,
    );
    expect(columns).toBe(width < 1024 ? 1 : 2);
  });
}
