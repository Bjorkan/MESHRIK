import { useMemo, useState } from 'react';
import MapLibreMap, {
  AttributionControl,
  Layer,
  Marker,
  Popup,
  Source,
} from 'react-map-gl/maplibre';
import type { FeatureCollection, LineString } from 'geojson';
import { EMBEDDED_MAP_ATTRIBUTION } from '../utils/mapLibre';
import { useMapStyle } from '../hooks/useMapStyle';

interface Neighbor {
  lat: number | null;
  lon: number | null;
  name: string | null;
  pubkey_prefix: string;
  snr: number;
}

interface Props {
  neighbors: Neighbor[];
  radioLat?: number | null;
  radioLon?: number | null;
  radioName?: string | null;
}

interface MiniMapPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  color: string;
  size: number;
  borderColor: string;
}

export function NeighborsMiniMap({ neighbors, radioLat, radioLon, radioName }: Props) {
  const { mapStyle } = useMapStyle();
  const [openPointId, setOpenPointId] = useState<string | null>(null);
  const valid = neighbors.filter(
    (neighbor): neighbor is Neighbor & { lat: number; lon: number } =>
      neighbor.lat != null && neighbor.lon != null
  );
  const hasRadio = radioLat != null && radioLon != null && !(radioLat === 0 && radioLon === 0);

  const lines = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: 'FeatureCollection',
      features: hasRadio
        ? valid.map((neighbor) => ({
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [radioLon!, radioLat!],
                [neighbor.lon, neighbor.lat],
              ],
            },
          }))
        : [],
    }),
    [hasRadio, radioLat, radioLon, valid]
  );

  if (valid.length === 0 && !hasRadio) return null;

  const center = hasRadio ? [radioLon!, radioLat!] : [valid[0].lon, valid[0].lat];
  const points: MiniMapPoint[] = [
    ...(hasRadio
      ? [
          {
            id: 'radio',
            lat: radioLat!,
            lon: radioLon!,
            label: radioName || 'Our Radio',
            color: '#3b82f6',
            size: 16,
            borderColor: '#1d4ed8',
          },
        ]
      : []),
    ...valid.map((neighbor, index) => ({
      id: `neighbor-${index}`,
      lat: neighbor.lat,
      lon: neighbor.lon,
      label: neighbor.name || neighbor.pubkey_prefix,
      color: neighbor.snr >= 6 ? '#22c55e' : neighbor.snr >= 0 ? '#eab308' : '#ef4444',
      size: 12,
      borderColor: '#000000',
    })),
  ];
  const openPoint = points.find((point) => point.id === openPointId);

  return (
    <div
      className="min-h-48 flex-1 rounded border border-border overflow-hidden"
      role="img"
      aria-label="Map showing repeater neighbor locations"
    >
      <MapLibreMap
        initialViewState={{ longitude: center[0], latitude: center[1], zoom: 10 }}
        mapStyle={mapStyle.url}
        attributionControl={false}
        style={{ width: '100%', height: '100%', background: mapStyle.background }}
      >
        <AttributionControl {...EMBEDDED_MAP_ATTRIBUTION} />
        {lines.features.length > 0 && (
          <Source id="neighbor-links" type="geojson" data={lines}>
            <Layer
              id="neighbor-links-line"
              type="line"
              paint={{ 'line-color': '#3b82f6', 'line-width': 1.5, 'line-opacity': 0.5 }}
              layout={{ 'line-cap': 'round' }}
            />
          </Source>
        )}
        {points.map((point) => (
          <Marker key={point.id} longitude={point.lon} latitude={point.lat} anchor="center">
            <button
              type="button"
              className="rounded-full"
              style={{
                width: point.size,
                height: point.size,
                backgroundColor: point.color,
                border: `2px solid ${point.borderColor}`,
              }}
              onClick={() => setOpenPointId(point.id)}
              aria-label={`Show ${point.label} on map`}
            />
          </Marker>
        ))}
        {openPoint && (
          <Popup
            longitude={openPoint.lon}
            latitude={openPoint.lat}
            anchor="bottom"
            offset={12}
            closeOnClick={false}
            onClose={() => setOpenPointId(null)}
          >
            <span className="text-sm font-medium">{openPoint.label}</span>
          </Popup>
        )}
      </MapLibreMap>
    </div>
  );
}
