import { expect, test, type Locator, type Page } from "@playwright/test";

const PUBLIC_CHANNEL_KEY = "8B3387E9C5CDEA6AC9E5EDBAA115CD72";
const SIDEBAR_ROW_COUNT = 1_000;
const SEARCH_RESULT_COUNT = 200;

type VirtualProbeWindow = Window & {
  __virtualProbe?: {
    blankFrames: number;
    frames: number;
    running: boolean;
  };
};

interface VisibleRow {
  key: string;
  offset: number;
}

function syntheticChannels(suffix: string) {
  return Array.from({ length: SIDEBAR_ROW_COUNT }, (_, index) => ({
    key: (index + 1).toString(16).padStart(32, "0").toUpperCase(),
    name: `#virtual-${suffix}-${index.toString().padStart(4, "0")}`,
    is_hashtag: true,
    on_radio: false,
    favorite: false,
    muted: false,
    flood_scope_override: null,
    path_hash_mode_override: null,
    last_read_at: null,
  }));
}

function syntheticSearchResults() {
  return Array.from({ length: SEARCH_RESULT_COUNT }, (_, index) => ({
    id: 900_000 + index,
    type: "CHAN",
    conversation_key: PUBLIC_CHANNEL_KEY,
    text: `Virtual browser result ${index} ${"variable height content ".repeat(index % 4)}`,
    received_at: 1_700_000_000 + index,
    outgoing: false,
    sender_name: `Sender ${index % 7}`,
  }));
}

async function installVirtualProbe(page: Page, selector: string) {
  await page.evaluate((viewportSelector) => {
    const probe = { blankFrames: 0, frames: 0, running: true };
    (window as VirtualProbeWindow).__virtualProbe = probe;

    const sample = () => {
      if (!probe.running) return;
      const viewport = document.querySelector<HTMLElement>(viewportSelector);
      if (viewport && viewport.offsetParent !== null) {
        probe.frames += 1;
        if (viewport.querySelectorAll("[data-virtual-row]").length === 0) {
          probe.blankFrames += 1;
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
}

async function finishVirtualProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as VirtualProbeWindow).__virtualProbe;
    if (!probe) throw new Error("Virtual viewport probe was not installed");
    probe.running = false;
    return { blankFrames: probe.blankFrames, frames: probe.frames };
  });
}

async function centeredRow(viewport: Locator): Promise<VisibleRow> {
  return viewport.evaluate((node) => {
    const viewportRect = node.getBoundingClientRect();
    const center = viewportRect.top + viewportRect.height / 2;
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>("[data-virtual-row]"),
    )
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.bottom > viewportRect.top && rect.top < viewportRect.bottom,
      )
      .sort(
        (a, b) =>
          Math.abs((a.rect.top + a.rect.bottom) / 2 - center) -
          Math.abs((b.rect.top + b.rect.bottom) / 2 - center),
      );
    const visible = rows[0];
    if (!visible) throw new Error("Virtual viewport has no centered row");
    return {
      key: visible.row.dataset.virtualRow ?? "",
      offset: visible.rect.top - viewportRect.top,
    };
  });
}

test.describe("TanStack Virtual browser stability", () => {
  test("rapid sidebar filters and keyboard route changes preserve focus, rows, and scroll", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const channels = syntheticChannels(suffix);
    await page.addInitScript(() => {
      localStorage.setItem("meshrik-auto-focus-input", "false");
    });

    await page.route("**/api/channels", async (route) => {
      await route.fulfill({
        status: 200,
        json: [
          {
            key: PUBLIC_CHANNEL_KEY,
            name: "Public",
            is_hashtag: false,
            on_radio: true,
            favorite: false,
            muted: false,
          },
          ...channels,
        ],
      });
    });
    await page.route("**/api/contacts?*", async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await page.goto("/");
    const input = page.getByLabel("Search conversations");
    await expect(input).toBeVisible();
    const viewport = page.locator('[data-virtual-viewport="sidebar"]');
    await expect(viewport.locator("[data-virtual-row]").first()).toBeVisible();
    await installVirtualProbe(page, '[data-virtual-viewport="sidebar"]');

    await input.focus();
    for (const query of [
      "virtual",
      `virtual-${suffix.slice(0, 2)}`,
      `virtual-${suffix}`,
    ]) {
      await input.fill(query);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      await expect(
        viewport.locator("[data-virtual-row]").first(),
      ).toBeVisible();
      await expect(input).toBeFocused();
    }
    await input.fill("");
    await expect(input).toBeFocused();

    const scrollContainer = viewport.locator("..");
    await scrollContainer.evaluate((node) => {
      node.scrollTop = node.scrollHeight * 0.55;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => scrollContainer.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(500);

    for (let change = 0; change < 3; change += 1) {
      const candidate = await centeredRow(viewport);
      const row = viewport.locator(
        `[data-virtual-row="${candidate.key}"] [role="button"]`,
      );
      await row.focus();
      await expect(row).toBeFocused();
      const beforeScrollTop = await scrollContainer.evaluate(
        (node) => node.scrollTop,
      );
      await row.press("Enter");
      await expect(page).toHaveURL(
        /\/(?:channel\/[A-F0-9]{32}|contact\/[a-f0-9]{64})/,
      );
      await expect(row).toBeFocused();
      await expect(row).toBeVisible();
      const after = await scrollContainer.evaluate((node) => ({
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      }));
      expect(after.scrollTop).toBeGreaterThan(500);
      expect(Math.abs(after.scrollTop - beforeScrollTop)).toBeLessThanOrEqual(
        after.clientHeight,
      );
    }

    const probe = await finishVirtualProbe(page);
    expect(probe.frames).toBeGreaterThan(0);
    expect(probe.blankFrames).toBe(0);
  });

  test("search results retain their scroll anchor across keyboard route changes", async ({
    page,
  }) => {
    const results = syntheticSearchResults();
    await page.addInitScript(() => {
      localStorage.setItem("meshrik-auto-focus-input", "false");
    });
    await page.route("**/api/messages?*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("q")) {
        await route.continue();
        return;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      await route.fulfill({
        status: 200,
        json: results.slice(offset, offset + limit),
      });
    });

    await page.goto("/search");
    const input = page.getByLabel("Search messages");
    await expect(input).toBeFocused();
    await input.fill("virtual browser");
    await expect(page).toHaveURL(/\/search\?q=virtual(?:%20|\+)browser/);
    await expect(
      page.getByText("Virtual browser result 0", { exact: false }),
    ).toBeVisible();
    await expect(input).toBeFocused();

    for (
      let pageNumber = 1;
      pageNumber < SEARCH_RESULT_COUNT / 50;
      pageNumber += 1
    ) {
      await page.getByRole("button", { name: "Load more results" }).click();
    }

    const viewport = page.locator('[data-virtual-viewport="search-results"]');
    const scrollContainer = viewport.locator("..");
    await scrollContainer.evaluate((node) => {
      node.scrollTop = node.scrollHeight * 0.5;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => scrollContainer.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(500);
    await installVirtualProbe(page, '[data-virtual-viewport="search-results"]');

    for (let change = 0; change < 2; change += 1) {
      const candidate = await centeredRow(viewport);
      const row = viewport.locator(
        `[data-virtual-row="${candidate.key}"] [role="button"]`,
      );
      await row.focus();
      await expect(row).toBeFocused();
      const beforeScrollTop = await scrollContainer.evaluate(
        (node) => node.scrollTop,
      );
      await row.press("Enter");
      await expect(page).toHaveURL(/\/channel\//);
      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=virtual(?:%20|\+)browser/);
      await expect(viewport).toBeVisible();
      await expect(row).toBeFocused();
      await expect(row).toBeVisible();
      const after = await scrollContainer.evaluate((node) => ({
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      }));
      expect(after.scrollTop).toBeGreaterThan(500);
      expect(Math.abs(after.scrollTop - beforeScrollTop)).toBeLessThanOrEqual(
        after.clientHeight,
      );
    }

    const probe = await finishVirtualProbe(page);
    expect(probe.frames).toBeGreaterThan(0);
    expect(probe.blankFrames).toBe(0);
  });
});
