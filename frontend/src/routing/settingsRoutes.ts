import type { SettingsSection } from '../components/settings/settingsConstants';

const SETTINGS_PATHS: Readonly<Record<SettingsSection, string>> = {
  radio: '/settings/radio',
  local: '/settings/local',
  'radio-app': '/settings/radio-app',
  fanout: '/settings/fanout',
  database: '/settings/database',
  statistics: '/settings/statistics',
  about: '/settings/about',
};

export function getSettingsPath(section: SettingsSection): string {
  return SETTINGS_PATHS[section];
}

export function getSettingsSection(pathname: string): SettingsSection | null {
  const entry = Object.entries(SETTINGS_PATHS).find(([, path]) => path === pathname);
  return (entry?.[0] as SettingsSection | undefined) ?? null;
}
