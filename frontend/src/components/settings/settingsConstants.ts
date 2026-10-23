import {
  BarChart3,
  Database,
  Info,
  MonitorCog,
  RadioTower,
  Share2,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { t } from '@lingui/core/macro';

export type SettingsSection =
  'radio' | 'local' | 'radio-app' | 'database' | 'fanout' | 'statistics' | 'about';

export const SETTINGS_SECTION_ORDER: SettingsSection[] = [
  'radio',
  'local',
  'fanout',
  'radio-app',
  'database',
  'statistics',
  'about',
];

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  get radio() {
    return t`Radio`;
  },
  get local() {
    return t`Local Configuration`;
  },
  get 'radio-app'() {
    return t`Radio-App Management`;
  },
  get database() {
    return t`Database`;
  },
  get fanout() {
    return t`MQTT & Automation`;
  },
  get statistics() {
    return t`Statistics`;
  },
  get about() {
    return t`About`;
  },
};

export const SETTINGS_SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  radio: RadioTower,
  local: MonitorCog,
  'radio-app': SlidersHorizontal,
  database: Database,
  fanout: Share2,
  statistics: BarChart3,
  about: Info,
};
