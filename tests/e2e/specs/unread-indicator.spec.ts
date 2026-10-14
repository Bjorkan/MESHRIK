import { test, expect } from "@playwright/test";
import { seedChannelUnread } from "../helpers/seed";

const CHANNEL_NAME = "#unread-e2e";

test.describe("Unread badge/pip", () => {
  test("unread badge appears for channel with new messages", async ({
    page,
  }) => {
    // Seed unread messages for the channel
    seedChannelUnread({ channelName: CHANNEL_NAME, unreadCount: 3 });

    await page.goto("/");
    await expect(page.getByRole("status", { name: "Radio OK" })).toBeVisible();

    // Find the channel in the sidebar
    const channelRow = page.getByText(CHANNEL_NAME, { exact: true }).first();
    await expect(channelRow).toBeVisible({ timeout: 15_000 });

    // Verify unread badge (rounded-full pip) is visible within the channel's sidebar row
    const sidebarRow = channelRow.locator(
      'xpath=ancestor::div[contains(@class,"cursor-pointer")][1]',
    );
    const unreadBadge = sidebarRow.locator("span.rounded-full");
    await expect(unreadBadge).toBeVisible();
  });

  test("deep-link hydration places the divider after a delayed unread snapshot", async ({
    page,
    request,
  }) => {
    const { key } = seedChannelUnread({
      channelName: "#unread-deep-link",
      unreadCount: 3,
    });
    let releaseResponse!: () => void;
    let responseCaptured!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      responseCaptured = resolve;
    });
    const unreadResponse = await request.get("/api/read-state/unreads");
    expect(unreadResponse.ok()).toBeTruthy();
    const unreadSnapshot = await unreadResponse.json();

    await page.route("**/api/read-state/unreads", async (route) => {
      responseCaptured();
      await release;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(unreadSnapshot),
      });
    });

    await page.goto(`/channel/${key}`);
    await captured;
    await expect(
      page.getByText("#unread-deep-link", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Unread messages", { exact: true }),
    ).toHaveCount(0);

    releaseResponse();

    await expect(
      page.getByText("Unread messages", { exact: true }),
    ).toBeVisible();
  });

  test("delayed unread hydration follows navigation to another channel", async ({
    page,
    request,
  }) => {
    const first = seedChannelUnread({
      channelName: "#unread-first",
      unreadCount: 2,
    });
    const second = seedChannelUnread({
      channelName: "#unread-second",
      unreadCount: 2,
    });
    let releaseResponse!: () => void;
    let responseCaptured!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      responseCaptured = resolve;
    });
    const unreadResponse = await request.get("/api/read-state/unreads");
    expect(unreadResponse.ok()).toBeTruthy();
    const unreadSnapshot = await unreadResponse.json();

    await page.route("**/api/read-state/unreads", async (route) => {
      responseCaptured();
      await release;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(unreadSnapshot),
      });
    });

    await page.goto(`/channel/${first.key}`);
    await captured;
    await page.getByText("#unread-second", { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/channel/${second.key}$`, "i"));

    releaseResponse();

    await expect(
      page.getByText("Unread messages", { exact: true }),
    ).toBeVisible();
  });
});
