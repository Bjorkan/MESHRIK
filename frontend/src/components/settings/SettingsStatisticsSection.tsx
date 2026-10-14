import { useState, useEffect, useMemo } from 'react';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { Separator } from '../ui/separator';
import { api } from '../../api';
import type { RegionScopeStats, StatisticsResponse } from '../../types';
import { formatLocaleNumber } from '@/utils/localeNumber';
import { TanStackBarChart, TanStackTimeSeriesChart } from '../charts/TanStackChart';

interface ActivityRow {
  label: string;
  lastHour: number;
  last24Hours: number;
  lastWeek: number;
}

const activityTableFeatures = tableFeatures({});
const activityColumns = [
  { accessorKey: 'label', header: '' },
  { accessorKey: 'lastHour', header: '1h' },
  { accessorKey: 'last24Hours', header: '24h' },
  { accessorKey: 'lastWeek', header: '7d' },
] satisfies Array<ColumnDef<typeof activityTableFeatures, ActivityRow>>;

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Regional flood-scope adoption. Deliberately shows fractions rather than bare
 * percentages: with adoption this sparse, "3 of 117" communicates the sample
 * size that "2.6%" hides.
 */
function RegionScopeStatsPanel({ stats }: { stats: RegionScopeStats }) {
  // Corrupt RF captures land in the packet table with random headers, some of
  // which claim to be region-scoped. At or below the measured floor there is
  // nothing to report but noise, so withhold the percentage and say so.
  const floor = stats.false_positive_floor;
  const withinNoise = stats.scoped_messages <= floor;
  // Real-world scoping is currently rare enough that the share rounds to "0.0%",
  // which reads as a broken widget. Below that resolution the fraction alone is
  // the honest presentation.
  const showTrafficPct = stats.total_messages > 0 && !withinNoise && stats.scoped_pct >= 0.05;

  return (
    <div>
      <h3 className="text-base font-semibold tracking-tight mb-2">Region Scope (24h)</h3>
      <p className="text-[0.8125rem] text-muted-foreground mb-3">
        How much local traffic uses regional flood scoping. Traffic covers all channel messages
        heard, including channels you have no key for; senders only counts channels you can decrypt,
        so the two use different denominators and will not match.
      </p>
      <div className="space-y-2">
        <div className="flex justify-between items-center gap-4">
          <span className="text-sm text-muted-foreground">Scoped messages</span>
          <span className="font-medium text-right">
            {formatLocaleNumber(stats.scoped_messages)} of{' '}
            {formatLocaleNumber(stats.total_messages)}
            {showTrafficPct && (
              <span className="text-muted-foreground"> ({formatPercent(stats.scoped_pct)})</span>
            )}
          </span>
        </div>
        <div className="flex justify-between items-center gap-4">
          <span className="text-sm text-muted-foreground">Senders using regions</span>
          <span className="font-medium text-right">
            {formatLocaleNumber(stats.scoped_senders)} of {formatLocaleNumber(stats.total_senders)}
            {stats.total_senders > 0 && (
              <span className="text-muted-foreground">
                {' '}
                ({formatPercent(stats.scoped_senders_pct)})
              </span>
            )}
          </span>
        </div>
      </div>
      {floor > 0 && stats.scoped_messages > 0 && (
        <p className="text-[0.8125rem] text-muted-foreground mt-2">
          {withinNoise
            ? `Scoped message count is at or below the estimated false-positive floor (${floor.toFixed(0)}) from corrupt packet captures, so it is not evidence of regional adoption.`
            : `Includes an estimated ${floor.toFixed(0)} false positives from corrupt packet captures.`}{' '}
          The sender count is unaffected — it requires successful decryption.
        </p>
      )}
      {stats.total_messages === 0 && (
        <p className="text-sm text-muted-foreground mt-2">
          No channel messages heard in the last 24 hours.
        </p>
      )}
    </div>
  );
}

const CHANNEL_BAR_COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6'];

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  );
}

function PacketsPerHourChart({ buckets }: { buckets: { timestamp: number; count: number }[] }) {
  // Fill gaps so hours with zero packets still appear on the chart
  const filled: { timestamp: number; count: number }[] = [];
  if (buckets.length > 0) {
    const first = buckets[0].timestamp;
    const last = buckets[buckets.length - 1].timestamp;
    const byTs = new Map(buckets.map((b) => [b.timestamp, b.count]));
    for (let ts = first; ts <= last; ts += 3600) {
      filled.push({ timestamp: ts, count: byTs.get(ts) ?? 0 });
    }
  }

  const data = filled.map((bucket) => ({
    category: formatDateTime(bucket.timestamp),
    values: { count: bucket.count },
  }));

  return (
    <TanStackTimeSeriesChart
      data={data}
      series={[{ key: 'count', label: 'Count', color: '#0ea5e9' }]}
      height={140}
      ariaLabel="Packets per hour over 72 hours"
      variant="area"
      valueFormatter={(value) => formatLocaleNumber(value)}
    />
  );
}

function NoiseFloorChart({
  samples,
}: {
  samples: { timestamp: number; noise_floor_dbm: number }[];
}) {
  const data = samples.map((sample) => ({
    category: formatTime(sample.timestamp),
    values: { noise_floor: sample.noise_floor_dbm },
  }));

  return (
    <TanStackTimeSeriesChart
      data={data}
      series={[{ key: 'noise_floor', label: 'Noise Floor', color: '#8b5cf6' }]}
      height={120}
      ariaLabel="Noise floor over 24 hours"
      variant="area"
      valueFormatter={(value) => `${value} dBm`}
    />
  );
}

export function SettingsStatisticsSection({ className }: { className?: string }) {
  const [stats, setStats] = useState<StatisticsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const activityRows = useMemo<ActivityRow[]>(
    () =>
      stats
        ? [
            {
              label: 'Contacts heard',
              lastHour: stats.contacts_heard.last_hour,
              last24Hours: stats.contacts_heard.last_24_hours,
              lastWeek: stats.contacts_heard.last_week,
            },
            {
              label: 'Repeaters heard',
              lastHour: stats.repeaters_heard.last_hour,
              last24Hours: stats.repeaters_heard.last_24_hours,
              lastWeek: stats.repeaters_heard.last_week,
            },
            {
              label: 'Known-channels active',
              lastHour: stats.known_channels_active.last_hour,
              last24Hours: stats.known_channels_active.last_24_hours,
              lastWeek: stats.known_channels_active.last_week,
            },
          ]
        : [],
    [stats]
  );
  const activityTable = useTable({
    features: activityTableFeatures,
    columns: activityColumns,
    data: activityRows,
    getRowId: (row) => row.label,
  });

  useEffect(() => {
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(false);
    api.getStatistics().then(
      (data) => {
        if (!cancelled) {
          setStats(data);
          setStatsLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setStatsError(true);
          setStatsLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={className}>
      {statsLoading && !stats ? (
        <div className="py-8 text-center text-muted-foreground">
          Loading statistics... this can take a while if you have a lot of stored packets.
        </div>
      ) : stats ? (
        <div className="space-y-6">
          {/* Network */}
          <div>
            <h3 className="text-base font-semibold tracking-tight mb-2">Network</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.contact_count}</div>
                <div className="text-xs text-muted-foreground">Contacts</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.repeater_count}</div>
                <div className="text-xs text-muted-foreground">Repeaters</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.channel_count}</div>
                <div className="text-xs text-muted-foreground">Channels</div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Messages */}
          <div>
            <h3 className="text-base font-semibold tracking-tight mb-2">Messages</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_dms}</div>
                <div className="text-xs text-muted-foreground">Direct Messages</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_channel_messages}</div>
                <div className="text-xs text-muted-foreground">Channel Messages</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_outgoing}</div>
                <div className="text-xs text-muted-foreground">Sent (Outgoing)</div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Activity */}
          <div>
            <h3 className="text-base font-semibold tracking-tight mb-2">Activity</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  {activityTable.getHeaderGroups().map((group) => (
                    <tr key={group.id} className="text-muted-foreground">
                      {group.headers.map((header) => (
                        <th
                          key={header.id}
                          className={`${header.id === 'label' ? 'text-left' : 'text-right'} font-normal pb-1`}
                        >
                          <activityTable.FlexRender header={header} />
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {activityTable.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getAllCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={`${cell.column.id === 'label' ? '' : 'text-right'} py-1`}
                        >
                          <activityTable.FlexRender cell={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Separator />

          {/* Packets */}
          <div>
            <h3 className="text-base font-semibold tracking-tight mb-2">Packets</h3>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Total stored</span>
                <span className="font-medium">{stats.total_packets}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-success">Decrypted</span>
                <span className="font-medium text-success">{stats.decrypted_packets}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-warning">Undecrypted</span>
                <span className="font-medium text-warning">{stats.undecrypted_packets}</span>
              </div>
            </div>
          </div>

          {/* Packets per Hour (72h) */}
          {stats.packets_per_hour_72h?.length > 0 && (
            <>
              <Separator />
              <div>
                <h3 className="text-base font-semibold tracking-tight mb-2">
                  Packets per Hour (72h)
                </h3>
                <PacketsPerHourChart buckets={stats.packets_per_hour_72h} />
              </div>
            </>
          )}

          <Separator />

          {/* Path Hash Width */}
          <div>
            <h3 className="text-base font-semibold tracking-tight mb-2">Path Hash Width (24h)</h3>
            <div className="mb-2 text-xs text-muted-foreground">
              Parsed stored raw packets from the last 24 hours:{' '}
              {stats.path_hash_width_24h.total_packets}
            </div>
            {stats.path_hash_width_24h.total_packets > 0 ? (
              <TanStackBarChart
                data={[
                  {
                    category: '1-byte',
                    values: { count: stats.path_hash_width_24h.single_byte },
                    color: '#0ea5e9',
                  },
                  {
                    category: '2-byte',
                    values: { count: stats.path_hash_width_24h.double_byte },
                    color: '#10b981',
                  },
                  {
                    category: '3-byte',
                    values: { count: stats.path_hash_width_24h.triple_byte },
                    color: '#f59e0b',
                  },
                ]}
                series={[{ key: 'count', label: 'Packets', color: '#0ea5e9' }]}
                height={120}
                ariaLabel="Path hash width packet counts"
              />
            ) : (
              <p className="text-sm text-muted-foreground">No path data in the last 24 hours.</p>
            )}
          </div>

          <Separator />

          {/* Region Scope */}
          <RegionScopeStatsPanel stats={stats.region_scope_24h} />

          {/* Busiest Channels */}
          {stats.busiest_channels_24h.length > 0 && (
            <>
              <Separator />
              <div>
                <h3 className="text-base font-semibold tracking-tight mb-2">
                  Busiest Channels (24h)
                </h3>
                <TanStackBarChart
                  data={stats.busiest_channels_24h.map((channel, index) => ({
                    category: channel.channel_name,
                    values: { messages: channel.message_count },
                    color: CHANNEL_BAR_COLORS[index % CHANNEL_BAR_COLORS.length],
                  }))}
                  series={[{ key: 'messages', label: 'Messages', color: CHANNEL_BAR_COLORS[0] }]}
                  height={stats.busiest_channels_24h.length * 28 + 8}
                  ariaLabel="Busiest channels over 24 hours"
                  horizontal
                />
              </div>
            </>
          )}

          {/* Noise Floor */}
          {stats.noise_floor_24h && (
            <>
              <Separator />
              <div>
                <h3 className="text-base font-semibold tracking-tight mb-2">Noise Floor (24h)</h3>
                {stats.noise_floor_24h.latest_noise_floor_dbm != null && (
                  <div className="mb-2 text-xs text-muted-foreground">
                    Latest reading: {stats.noise_floor_24h.latest_noise_floor_dbm} dBm
                    {stats.noise_floor_24h.latest_timestamp != null &&
                      ` at ${new Date(
                        stats.noise_floor_24h.latest_timestamp * 1000
                      ).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`}
                  </div>
                )}
                {stats.noise_floor_24h.samples.length > 1 ? (
                  <NoiseFloorChart samples={stats.noise_floor_24h.samples} />
                ) : stats.noise_floor_24h.samples.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No noise floor samples collected yet. Samples are collected every minute and
                    retained until server restart.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Only one sample so far ({stats.noise_floor_24h.samples[0].noise_floor_dbm} dBm).
                    More data needed for a chart. Samples are collected every minute and retained
                    until server restart.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      ) : statsError ? (
        <div className="py-8 text-center text-muted-foreground">Failed to load statistics.</div>
      ) : null}
    </div>
  );
}
