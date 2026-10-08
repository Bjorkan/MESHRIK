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
] as const;

export const DEFAULT_MAP_STYLE = MAP_STYLES[0];
