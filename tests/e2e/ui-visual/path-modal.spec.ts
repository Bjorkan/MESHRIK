import { expect, test } from "@playwright/test";

for (const width of [320, 375, 390, 1024]) {
  for (const scale of [100, 200]) {
    test(`resend consequences stay inside buttons at ${width}px / ${scale}%`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      for (const state of ["", "&expired", "&paths", "&paths&expired"]) {
        await page.goto(`/?scale=${scale}${state}`);
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const actions = dialog.getByRole("button", { name: /↻ Resend/ });
        await expect(actions).toHaveCount(state.includes("expired") ? 1 : 2);
        for (const action of await actions.all()) {
          // Also stress wrapping with a longer synthetic/localized explanation.
          await action
            .locator("span span")
            .last()
            .evaluate((el) => {
              el.textContent += " — additional explanation for this action";
            });
          await action.scrollIntoViewIfNeeded();
          const geometry = await action.evaluate((el) => {
            const button = el.getBoundingClientRect();
            return {
              overflow: el.scrollWidth > el.clientWidth,
              contained: [...el.querySelectorAll("span")].every((span) => {
                const bounds = span.getBoundingClientRect();
                return (
                  bounds.left >= button.left &&
                  bounds.right <= button.right &&
                  bounds.top >= button.top &&
                  bounds.bottom <= button.bottom
                );
              }),
              inViewport: button.left >= 0 && button.right <= innerWidth,
            };
          });
          expect(geometry).toEqual({
            overflow: false,
            contained: true,
            inViewport: true,
          });
        }
        await expect(
          dialog.getByRole("button", { name: "Close", exact: true }).last(),
        ).toBeVisible();
      }
    });
  }
}

test("keyboard activation preserves each resend meaning and closes the dialog", async ({
  page,
}) => {
  for (const [name, result] of [
    ["↻ Resend Only repeated by new repeaters", "42:repeat"],
    ["↻ Resend as new Will appear as duplicate to receivers", "42:new"],
  ]) {
    await page.goto("/");
    const action = page.getByRole("button", { name, exact: true });
    await action.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Send result")).toHaveText(result);
  }
});
