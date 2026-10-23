import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { RepeaterPane, NotFetched, KvRow, formatClockDrift } from './repeaterPaneShared';
import type { RepeaterNodeInfoResponse, PaneState } from '../../types';

export function NodeInfoPane({
  data,
  state,
  onRefresh,
  disabled,
}: {
  data: RepeaterNodeInfoResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  useLingui();

  const clockDrift = useMemo(() => {
    if (!data?.clock_utc) return null;
    return formatClockDrift(data.clock_utc, state.fetched_at ?? undefined);
  }, [data?.clock_utc, state.fetched_at]);

  return (
    <RepeaterPane title={t`Node Info`} state={state} onRefresh={onRefresh} disabled={disabled}>
      {!data ? (
        <NotFetched />
      ) : (
        <div>
          <KvRow label={t`Name`} value={data.name ?? '—'} />
          <KvRow
            label={t`Lat / Lon`}
            value={
              data.lat != null || data.lon != null ? `${data.lat ?? '—'}, ${data.lon ?? '—'}` : '—'
            }
          />
          <div className="flex justify-between text-sm py-0.5">
            <span className="text-muted-foreground">
              <Trans>Clock (UTC)</Trans>
            </span>
            <span>
              {data.clock_utc ?? '—'}
              {clockDrift && (
                <span
                  className={cn(
                    'ml-2 text-xs',
                    clockDrift.isLarge ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  <Trans>(drift: {clockDrift.text})</Trans>
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </RepeaterPane>
  );
}
