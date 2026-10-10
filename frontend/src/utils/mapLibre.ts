import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);

export interface MapStylePreset {
  id: string;
  label: string;
  url: string;
  background: string;
}

export type MapAppearance = 'light' | 'dark';
export const MAP_STYLE_AUTO_ID = 'auto';
export const MAP_STYLE_STORAGE_KEY = 'meshrik-map-layer';
export const LEGACY_DARK_MAP_STORAGE_KEY = 'meshrik-dark-map';

/** API-key-free vector styles served by OpenFreeMap for MapLibre GL. */
export const MAP_STYLES: readonly MapStylePreset[] = [
  {
    id: 'liberty',
    label: 'Liberty',
    url: 'https://tiles.openfreemap.org/styles/liberty',
    background: '#dbeafe',
  },
  {
    id: 'bright',
    label: 'Bright',
    url: 'https://tiles.openfreemap.org/styles/bright',
    background: '#eef2f7',
  },
  {
    id: 'dark',
    label: 'Dark',
    url: 'https://tiles.openfreemap.org/styles/dark',
    background: '#111827',
  },
] as const;

export const DEFAULT_MAP_STYLE = MAP_STYLES[0];
export const DEFAULT_DARK_MAP_STYLE = MAP_STYLES[2];

const LIGHT_THEME_IDS = new Set(['light', 'ios', 'paper-grove', 'monochrome', 'windows-95']);

/** Explicitly classify every bundled palette by its rendered appearance. */
export function getMapAppearanceForTheme(themeId: string): MapAppearance {
  return LIGHT_THEME_IDS.has(themeId) ? 'light' : 'dark';
}

export function getSavedMapStyleId(): string {
  try {
    const stored = localStorage.getItem(MAP_STYLE_STORAGE_KEY);
    if (
      stored &&
      (stored === MAP_STYLE_AUTO_ID || MAP_STYLES.some((style) => style.id === stored))
    ) {
      return stored;
    }
  } catch {
    // localStorage may be disabled; use theme-following behavior.
  }
  return MAP_STYLE_AUTO_ID;
}

export function resolveMapStyle(selectionId: string, effectiveThemeId: string): MapStylePreset {
  const manual = MAP_STYLES.find((style) => style.id === selectionId);
  if (manual) return manual;
  return getMapAppearanceForTheme(effectiveThemeId) === 'light'
    ? DEFAULT_MAP_STYLE
    : DEFAULT_DARK_MAP_STYLE;
}

/** Shared compact attribution contract for embedded maps. */
export const EMBEDDED_MAP_ATTRIBUTION = {
  compact: true,
  position: 'bottom-right',
} as const;
