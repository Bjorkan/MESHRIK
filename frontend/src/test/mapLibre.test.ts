import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_MAP_STYLE,
  DEFAULT_MAP_STYLE,
  EMBEDDED_MAP_ATTRIBUTION,
  MAP_STYLE_AUTO_ID,
  getMapAppearanceForTheme,
  getSavedMapStyleId,
  resolveMapStyle,
} from '../utils/mapLibre';

describe('map style resolution', () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ['light', 'light'],
    ['ios', 'light'],
    ['paper-grove', 'light'],
    ['monochrome', 'light'],
    ['windows-95', 'light'],
    ['original', 'dark'],
    ['cyberpunk', 'dark'],
    ['obsidian-glass', 'dark'],
    ['solar-flare', 'dark'],
    ['lagoon-pop', 'dark'],
    ['candy-dusk', 'dark'],
    ['high-contrast', 'dark'],
  ])('maps %s to a %s basemap appearance', (theme, appearance) => {
    expect(getMapAppearanceForTheme(theme)).toBe(appearance);
  });

  it('uses the effective appearance for Auto', () => {
    expect(resolveMapStyle(MAP_STYLE_AUTO_ID, 'original')).toBe(DEFAULT_DARK_MAP_STYLE);
    expect(resolveMapStyle(MAP_STYLE_AUTO_ID, 'light')).toBe(DEFAULT_MAP_STYLE);
  });

  it('keeps a manual style independent from theme changes', () => {
    expect(resolveMapStyle('bright', 'original').id).toBe('bright');
    expect(resolveMapStyle('dark', 'light').id).toBe('dark');
  });

  it('falls back invalid and legacy storage values to Auto', () => {
    localStorage.setItem('meshrik-map-layer', 'unknown');
    expect(getSavedMapStyleId()).toBe(MAP_STYLE_AUTO_ID);
  });

  it('requires compact, expandable attribution on embedded maps', () => {
    expect(EMBEDDED_MAP_ATTRIBUTION).toEqual({ compact: true, position: 'bottom-right' });
  });
});
