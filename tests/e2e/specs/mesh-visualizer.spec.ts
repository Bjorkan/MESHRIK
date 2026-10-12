import { test, expect } from '@playwright/test';

test.describe('Mesh Visualizer page', () => {
  test('mesh visualizer page loads', async ({ page }) => {
    await page.goto('/visualizer');

    // Verify heading (may appear in sidebar too, use first())
    await expect(page.getByText('Mesh Visualizer').first()).toBeVisible({ timeout: 15_000 });

    // Verify Three.js canvas element exists (may have 0x0 dimensions in headless mode,
    // so check attachment rather than visibility)
    await expect(page.locator('canvas[data-engine^="three.js"]').first()).toBeAttached({
      timeout: 15_000,
    });
  });
});
