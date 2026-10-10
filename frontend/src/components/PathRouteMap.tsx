import { useCallback, useRef, useState } from 'react';
import MapLibreMap, { AttributionControl, Marker, Popup, type MapRef } from 'react-map-gl/maplibre';
import { EMBEDDED_MAP_ATTRIBUTION } from '../utils/mapLibre';
import { useMapStyle } from '../hooks/useMapStyle';
import { isValidLocation } from '../utils/pathUtils';
import type { ResolvedPath, SenderInfo } from '../utils/pathUtils';

interface PathRouteMapProps {
  resolved: ResolvedPath;
  senderInfo: SenderInfo;
  height?: number;
}

const HOP_COLORS = [
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#ec4899',
  '#f43f5e',
  '#a855f7',
  '#64748b',
];
const SENDER_COLOR = '#3b82f6';
const RECEIVER_COLOR = '#8b5cf6';

function getHopColor(hopIndex: number): string {
  return HOP_COLORS[hopIndex % HOP_COLORS.length];
}

function collectPoints(resolved: ResolvedPath): [number, number][] {
  const points: [number, number][] = [];
  if (isValidLocation(resolved.sender.lat, resolved.sender.lon)) {
    points.push([resolved.sender.lat!, resolved.sender.lon!]);
  }
  for (const hop of resolved.hops) {
    for (const match of hop.matches) {
      if (isValidLocation(match.lat, match.lon)) points.push([match.lat!, match.lon!]);
    }
  }
  if (isValidLocation(resolved.receiver.lat, resolved.receiver.lon)) {
    points.push([resolved.receiver.lat!, resolved.receiver.lon!]);
  }
  return points;
}

function NumberedMarker({
  label,
  color,
  longitude,
  latitude,
  description,
}: {
  label: string;
  color: string;
  longitude: number;
  latitude: number;
  description: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Marker longitude={longitude} latitude={latitude} anchor="center">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white/80 text-[0.6875rem] font-bold text-white shadow-md"
          style={{ backgroundColor: color }}
          onClick={() => setOpen(true)}
          aria-label={`Show ${label} node details`}
        >
          {label}
        </button>
      </Marker>
      {open && (
        <Popup
          longitude={longitude}
          latitude={latitude}
          anchor="bottom"
          offset={16}
          closeOnClick={false}
          onClose={() => setOpen(false)}
        >
          <div className="text-xs">{description}</div>
        </Popup>
      )}
    </>
  );
}

export function PathRouteMap({ resolved, senderInfo, height = 220 }: PathRouteMapProps) {
  const { mapStyle } = useMapStyle();
  const mapRef = useRef<MapRef>(null);
  const points = collectPoints(resolved);
  const hasAnyGps = points.length > 0;

  let totalNodes = 2;
  let nodesWithGps = 0;
  if (isValidLocation(resolved.sender.lat, resolved.sender.lon)) nodesWithGps++;
  if (isValidLocation(resolved.receiver.lat, resolved.receiver.lon)) nodesWithGps++;
  for (const hop of resolved.hops) {
    if (hop.matches.length === 0) {
      totalNodes++;
    } else {
      totalNodes += hop.matches.length;
      nodesWithGps += hop.matches.filter((match) => isValidLocation(match.lat, match.lon)).length;
    }
  }
  const someMissingGps = hasAnyGps && nodesWithGps < totalNodes;

  const fitRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    if (points.length === 1) {
      map.jumpTo({ center: [points[0][1], points[0][0]], zoom: 12 });
      return;
    }
    const lons = points.map(([, lon]) => lon);
    const lats = points.map(([lat]) => lat);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 30, maxZoom: 14, duration: 0 }
    );
  }, [points]);

  if (!hasAnyGps) {
    return (
      <div className="h-14 rounded border border-border bg-muted/30 flex items-center justify-center text-sm text-muted-foreground">
        No nodes in this route have GPS coordinates
      </div>
    );
  }

  const center = points[0];
  return (
    <div>
      <div
        className="rounded border border-border overflow-hidden"
        role="img"
        aria-label="Map showing message route between nodes"
        style={{ height }}
      >
        <MapLibreMap
          ref={mapRef}
          initialViewState={{ longitude: center[1], latitude: center[0], zoom: 10 }}
          mapStyle={mapStyle.url}
          attributionControl={false}
          onLoad={fitRoute}
          style={{ width: '100%', height: '100%', background: mapStyle.background }}
        >
          <AttributionControl {...EMBEDDED_MAP_ATTRIBUTION} />
          {isValidLocation(resolved.sender.lat, resolved.sender.lon) && (
            <NumberedMarker
              label="S"
              color={SENDER_COLOR}
              longitude={resolved.sender.lon!}
              latitude={resolved.sender.lat!}
              description={
                <>
                  <span className="font-mono">{resolved.sender.prefix}</span>
                  {' · '}
                  {senderInfo.name || 'Sender'}
                </>
              }
            />
          )}
          {resolved.hops.map((hop, hopIdx) =>
            hop.matches
              .filter((match) => isValidLocation(match.lat, match.lon))
              .map((match, matchIdx) => (
                <NumberedMarker
                  key={`hop-${hopIdx}-${matchIdx}`}
                  label={String(hopIdx + 1)}
                  color={getHopColor(hopIdx)}
                  longitude={match.lon!}
                  latitude={match.lat!}
                  description={
                    <>
                      <span className="font-mono">{hop.prefix}</span>
                      {' · '}
                      {match.name || match.public_key.slice(0, 12)}
                    </>
                  }
                />
              ))
          )}
          {isValidLocation(resolved.receiver.lat, resolved.receiver.lon) && (
            <NumberedMarker
              label="R"
              color={RECEIVER_COLOR}
              longitude={resolved.receiver.lon!}
              latitude={resolved.receiver.lat!}
              description={
                <>
                  <span className="font-mono">{resolved.receiver.prefix}</span>
                  {' · '}
                  {resolved.receiver.name || 'Receiver'}
                </>
              }
            />
          )}
        </MapLibreMap>
      </div>
      {someMissingGps && (
        <p className="text-xs text-muted-foreground mt-1">
          Some nodes in this route have no GPS and are not shown
        </p>
      )}
    </div>
  );
}
