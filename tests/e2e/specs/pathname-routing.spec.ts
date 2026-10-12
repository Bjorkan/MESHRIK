import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { createChannel, createContact, deleteChannel, deleteContact } from '../helpers/api';

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Canonical pathname routing', () => {
  let channelName = '';
  let channelKey = '';
  let contactKey = '';
  let contactName = '';

  test.beforeAll(async () => {
    channelName = `#e2eroute${Date.now().toString().slice(-6)}`;
    channelKey = (await createChannel(channelName)).key;
    contactKey = randomHex(32);
    contactName = `E2E Route ${Date.now().toString().slice(-5)}`;
    await createContact(contactKey, contactName);
  });

  test.afterAll(async () => {
    try {
      await deleteChannel(channelKey);
    } catch {
      // Best-effort cleanup
    }
    try {
      await deleteContact(contactKey);
    } catch {
      // Best-effort cleanup
    }
  });

  test('loads known channel and exact full-key contact routes directly', async ({ page }) => {
    await page.goto(`/channel/${channelKey}`);
    await expect(
      page.getByPlaceholder(new RegExp(`message\\s+${escapeRegex(channelName)}`, 'i'))
    ).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/channel/${channelKey}`);

    await page.goto(`/contact/${contactKey}`);
    await expect(
      page.getByPlaceholder(new RegExp(`message\\s+${escapeRegex(contactName)}`, 'i'))
    ).toBeVisible();
    await expect(page.getByText(contactKey, { exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/contact/${contactKey}`);
  });

  test('direct-loads every static pathname route without the application 404', async ({ page }) => {
    const routes = [
      '/',
      '/raw',
      '/map',
      `/map?focus=${contactKey}`,
      '/visualizer',
      '/search',
      '/trace',
      '/radio-activity',
      '/settings/radio',
      '/settings/local',
      '/settings/radio-app',
      '/settings/fanout',
      '/settings/database',
      '/settings/statistics',
      '/settings/about',
    ];

    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole('status', { name: 'Radio OK' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(new URL(route, 'http://example.test').pathname);
    }
    expect(new URL(page.url()).hash).toBe('');
  });

  test('uses browser Back and Forward across entity, settings, and tool routes', async ({
    page,
  }) => {
    await page.goto(`/channel/${channelKey}`);
    await page.goto('/settings/local');
    await page.goto('/raw');
    await page.goto(`/contact/${contactKey}`);

    await page.goBack();
    expect(new URL(page.url()).pathname).toBe('/raw');
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe('/settings/local');
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe(`/channel/${channelKey}`);

    await page.goForward();
    expect(new URL(page.url()).pathname).toBe('/settings/local');
    await page.goForward();
    expect(new URL(page.url()).pathname).toBe('/raw');
    await page.goForward();
    expect(new URL(page.url()).pathname).toBe(`/contact/${contactKey}`);
  });

  test('shows the application 404 for an unknown pathname', async ({ page }) => {
    await page.goto('/does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
