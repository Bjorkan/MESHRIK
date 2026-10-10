import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LEGACY_DARK_MAP_STORAGE_KEY,
  MAP_STYLE_AUTO_ID,
  MAP_STYLE_STORAGE_KEY,
  MAP_STYLES,
  getSavedMapStyleId,
  resolveMapStyle,
} from '../utils/mapLibre';
import { getEffectiveTheme, THEME_CHANGE_EVENT } from '../utils/theme';

export function useMapStyle() {
  const [selectionId, setSelectionId] = useState(getSavedMapStyleId);
  const [effectiveTheme, setEffectiveTheme] = useState(getEffectiveTheme);

  useEffect(() => {
    const syncTheme = () => setEffectiveTheme(getEffectiveTheme());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MAP_STYLE_STORAGE_KEY) {
        setSelectionId(getSavedMapStyleId());
      }
      if (event.key === 'meshrik-theme') {
        syncTheme();
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncTheme);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  const setMapStyle = useCallback((nextId: string) => {
    if (nextId !== MAP_STYLE_AUTO_ID && !MAP_STYLES.some((style) => style.id === nextId)) return;
    setSelectionId(nextId);
    try {
      localStorage.setItem(MAP_STYLE_STORAGE_KEY, nextId);
      localStorage.removeItem(LEGACY_DARK_MAP_STORAGE_KEY);
    } catch {
      // The in-memory choice still works when storage is unavailable.
    }
  }, []);

  return {
    selectionId,
    mapStyle: useMemo(
      () => resolveMapStyle(selectionId, effectiveTheme),
      [effectiveTheme, selectionId]
    ),
    setMapStyle,
  };
}
