import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { RepeaterPane, NotFetched } from './repeaterPaneShared';
import { cn } from '@/lib/utils';
import type { RepeaterRegionsResponse, PaneState } from '../../types';

export function RegionsPane({
  data,
  state,
  onRefresh,
  disabled,
}: {
  data: RepeaterRegionsResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  useLingui();

  const headerNote = data?.truncated
    ? 'List truncated by the radio — showing the first regions only'
    : data?.source === 'anon'
      ? 'Guest view: flood-allowed regions only (log in as admin for the full hierarchy)'
      : 'Region hierarchy and flood permissions';

  return (
    <RepeaterPane
      title={t`Regions`}
      state={state}
      onRefresh={onRefresh}
      disabled={disabled}
      headerNote={headerNote}
    >
      {!data ? (
        <NotFetched />
      ) : data.regions.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          <Trans>
            No regions returned. The repeater may be unreachable, or full region details require
            admin access.
          </Trans>
        </p>
      ) : (
        <div className="space-y-0.5">
          {data.regions.map((region, index) => (
            <div
              key={`${region.depth}-${region.name}-${index}`}
              className="flex items-center gap-2 text-sm py-0.5"
              style={{ paddingLeft: `${region.depth * 0.9}rem` }}
            >
              <span className="font-mono truncate">
                {region.name === '*' ? t`∗ (all regions)` : region.name}
              </span>
              {region.is_home && (
                <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  <Trans>Home</Trans>
                </span>
              )}
              <span
                className={cn(
                  'ml-auto shrink-0 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded',
                  region.flood_allowed
                    ? 'bg-success/15 text-success'
                    : 'bg-muted text-muted-foreground'
                )}
                title={
                  region.flood_allowed
                    ? t`Flood is allowed for this region`
                    : t`Flood is blocked for this region`
                }
              >
                {region.flood_allowed ? t`Flood` : t`Blocked`}
              </span>
            </div>
          ))}
        </div>
      )}
    </RepeaterPane>
  );
}
