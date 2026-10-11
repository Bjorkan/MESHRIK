import { describe, expect, it } from 'vitest';

import { getSettingsPath, getSettingsSection } from '../routing/settingsRoutes';

describe('settings pathname routing', () => {
  it.each([
    ['radio', '/settings/radio'],
    ['local', '/settings/local'],
    ['radio-app', '/settings/radio-app'],
    ['fanout', '/settings/fanout'],
    ['database', '/settings/database'],
    ['statistics', '/settings/statistics'],
    ['about', '/settings/about'],
  ] as const)('round-trips the %s section', (section, pathname) => {
    expect(getSettingsPath(section)).toBe(pathname);
    expect(getSettingsSection(pathname)).toBe(section);
  });

  it('rejects an unknown settings pathname', () => {
    expect(getSettingsSection('/settings/not-a-section')).toBeNull();
  });
});
