import { useMemo, lazy, Suspense } from 'react';
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { RepeaterPane, NotFetched, formatDuration } from './repeaterPaneShared';
import { isValidLocation, calculateDistance, formatDistance } from '../../utils/pathUtils';
import { useDistanceUnit } from '../../contexts/DistanceUnitContext';
import type {
  Contact,
  RepeaterNeighborsResponse,
  PaneState,
  NeighborInfo,
  RepeaterNodeInfoResponse,
} from '../../types';

const NeighborsMiniMap = lazy(() =>
  import('../NeighborsMiniMap').then((m) => ({ default: m.NeighborsMiniMap }))
);

type EnrichedNeighbor = NeighborInfo & { distance: string | null; distanceKm: number | null };

const neighborTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const neighborColumns = [
  {
    id: 'name',
    header: 'Name',
    accessorFn: (neighbor: EnrichedNeighbor) =>
      (neighbor.name || neighbor.pubkey_prefix).toLowerCase(),
    sortDescFirst: false,
  },
  { accessorKey: 'snr', header: 'SNR', sortDescFirst: true },
  {
    id: 'distance',
    header: 'Dist',
    accessorFn: (neighbor: EnrichedNeighbor) => neighbor.distanceKm ?? undefined,
    sortDescFirst: false,
    sortUndefined: 'last',
  },
  {
    accessorKey: 'last_heard_seconds',
    id: 'last_heard',
    header: 'Last Heard',
    sortDescFirst: false,
  },
] satisfies Array<ColumnDef<typeof neighborTableFeatures, EnrichedNeighbor>>;

export function NeighborsPane({
  data,
  state,
  onRefresh,
  disabled,
  repeaterContact,
  contacts,
  nodeInfo,
  nodeInfoState,
  repeaterName,
}: {
  data: RepeaterNeighborsResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
  repeaterContact: Contact | null;
  contacts: Contact[];
  nodeInfo: RepeaterNodeInfoResponse | null;
  nodeInfoState: PaneState;
  repeaterName: string | null;
}) {
  const { distanceUnit } = useDistanceUnit();
  const advertLat = repeaterContact?.lat ?? null;
  const advertLon = repeaterContact?.lon ?? null;

  const radioLat = useMemo(() => {
    const parsed = nodeInfo?.lat != null ? parseFloat(nodeInfo.lat) : null;
    return Number.isFinite(parsed) ? parsed : null;
  }, [nodeInfo?.lat]);

  const radioLon = useMemo(() => {
    const parsed = nodeInfo?.lon != null ? parseFloat(nodeInfo.lon) : null;
    return Number.isFinite(parsed) ? parsed : null;
  }, [nodeInfo?.lon]);

  const positionSource = useMemo(() => {
    if (isValidLocation(radioLat, radioLon)) {
      return { lat: radioLat, lon: radioLon, source: 'reported' as const };
    }
    if (isValidLocation(advertLat, advertLon)) {
      return { lat: advertLat, lon: advertLon, source: 'advert' as const };
    }
    return { lat: null, lon: null, source: null };
  }, [advertLat, advertLon, radioLat, radioLon]);

  const radioName = nodeInfo?.name || repeaterContact?.name || repeaterName;
  const hasValidRepeaterGps = positionSource.source !== null;
  const headerNote =
    positionSource.source === 'reported'
      ? 'Using repeater-reported position'
      : positionSource.source === 'advert'
        ? 'Using advert position'
        : nodeInfoState.loading
          ? 'Waiting for repeater position'
          : 'No repeater position available';

  // Resolve contact data for each neighbor in a single pass — used for coords
  // (mini-map) and distances (table column + distance sort). The formatted
  // string drives display; the raw km drives numeric distance sorting.
  const { neighborsWithCoords, enriched, hasDistances } = useMemo(() => {
    if (!data) {
      return {
        neighborsWithCoords: [] as Array<NeighborInfo & { lat: number | null; lon: number | null }>,
        enriched: [] as EnrichedNeighbor[],
        hasDistances: false,
      };
    }

    const withCoords: Array<NeighborInfo & { lat: number | null; lon: number | null }> = [];
    const list: EnrichedNeighbor[] = [];
    let anyDist = false;

    for (const n of data.neighbors) {
      const contact = contacts.find((c) => c.public_key.startsWith(n.pubkey_prefix));
      const nLat = contact?.lat ?? null;
      const nLon = contact?.lon ?? null;

      let dist: string | null = null;
      let distKm: number | null = null;
      if (hasValidRepeaterGps && isValidLocation(nLat, nLon)) {
        const km = calculateDistance(positionSource.lat, positionSource.lon, nLat, nLon);
        if (km != null) {
          distKm = km;
          dist = formatDistance(km, distanceUnit);
          anyDist = true;
        }
      }
      list.push({ ...n, distance: dist, distanceKm: distKm });

      if (isValidLocation(nLat, nLon)) {
        withCoords.push({ ...n, lat: nLat, lon: nLon });
      }
    }

    return {
      neighborsWithCoords: withCoords,
      enriched: list,
      hasDistances: anyDist,
    };
  }, [contacts, data, distanceUnit, hasValidRepeaterGps, positionSource.lat, positionSource.lon]);

  const table = useTable({
    features: neighborTableFeatures,
    columns: neighborColumns,
    data: enriched,
    getRowId: (neighbor) => neighbor.pubkey_prefix,
    initialState: { sorting: [{ id: 'snr', desc: true }] },
  });
  const rows = table.getRowModel().rows;

  return (
    <RepeaterPane
      title={
        !data
          ? 'Neighbors'
          : data.reported_count != null && data.reported_count !== data.neighbors.length
            ? `Neighbors (${data.neighbors.length} of ${data.reported_count})`
            : `Neighbors (${data.reported_count ?? data.neighbors.length})`
      }
      headerNote={headerNote}
      state={state}
      onRefresh={onRefresh}
      disabled={disabled}
      className={rows.length > 0 ? 'flex min-h-0 flex-col' : undefined}
      contentClassName={rows.length > 0 ? 'flex min-h-0 flex-col' : undefined}
    >
      {!data ? (
        <NotFetched />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No neighbors reported</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="shrink-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id} className="text-left text-muted-foreground text-xs">
                    {group.headers
                      .filter((header) => hasDistances || header.id !== 'distance')
                      .map((header) => {
                        const sorted = header.column.getIsSorted();
                        return (
                          <th
                            key={header.id}
                            className={cn('pb-1 font-medium', header.id !== 'name' && 'text-right')}
                            aria-sort={
                              sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none'
                            }
                          >
                            <button
                              type="button"
                              className="select-none hover:text-foreground transition-colors"
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              <table.FlexRender header={header} />{' '}
                              {sorted ? (sorted === 'asc' ? '▲' : '▼') : ''}
                            </button>
                          </th>
                        );
                      })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.map((row) => {
                  const n = row.original;
                  const dist = n.distance;
                  const snrStr = n.snr >= 0 ? `+${n.snr.toFixed(1)}` : n.snr.toFixed(1);
                  const snrColor =
                    n.snr >= 6 ? 'text-success' : n.snr >= 0 ? 'text-warning' : 'text-destructive';
                  return (
                    <tr key={row.id} className="border-t border-border/50">
                      <td className="py-1">
                        {n.name || n.pubkey_prefix}
                        {n.name && (
                          <span className="ml-1 text-muted-foreground font-mono text-[0.6875rem]">
                            {n.pubkey_prefix.substring(0, 6)}
                          </span>
                        )}
                      </td>
                      <td className={cn('py-1 text-right font-mono', snrColor)}>{snrStr} dB</td>
                      {hasDistances && (
                        <td className="py-1 text-right text-muted-foreground font-mono">
                          {dist ?? '—'}
                        </td>
                      )}
                      <td className="py-1 text-right text-muted-foreground">
                        {formatDuration(n.last_heard_seconds)} ago
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hasValidRepeaterGps && (neighborsWithCoords.length > 0 || hasValidRepeaterGps) ? (
            <Suspense
              fallback={
                <div className="flex min-h-48 flex-1 items-center justify-center text-xs text-muted-foreground">
                  Loading map...
                </div>
              }
            >
              <NeighborsMiniMap
                key={neighborsWithCoords.map((n) => n.pubkey_prefix).join(',')}
                neighbors={neighborsWithCoords}
                radioLat={positionSource.lat}
                radioLon={positionSource.lon}
                radioName={radioName}
              />
            </Suspense>
          ) : (
            <div className="rounded border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              Map and distance data are unavailable until this repeater has a valid position from
              either its advert or a Node Info fetch.
            </div>
          )}
        </div>
      )}
    </RepeaterPane>
  );
}
