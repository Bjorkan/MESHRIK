import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { getLocale } from '@/i18n';
import type { ReactNode } from 'react';
import { Separator } from '../ui/separator';
import { RepeaterPane, NotFetched, KvRow, formatDuration } from './repeaterPaneShared';
import type { RepeaterStatusResponse, PaneState } from '../../types';

function Secondary({ children }: { children: ReactNode }) {
  useLingui();

  return <span className="ml-1.5 font-normal text-muted-foreground">{children}</span>;
}

function formatAirtimePercent(airtimeSec: number, uptimeSec: number): string | null {
  if (uptimeSec <= 0) return null;
  return `${((airtimeSec / uptimeSec) * 100).toFixed(2)}%`;
}

function formatPerMinute(count: number, uptimeSec: number): string | null {
  if (uptimeSec <= 0) return null;
  const rate = (count * 60) / uptimeSec;
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
}

export function TelemetryPane({
  data,
  state,
  onRefresh,
  disabled,
}: {
  data: RepeaterStatusResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  useLingui();

  const txPct = data ? formatAirtimePercent(data.airtime_seconds, data.uptime_seconds) : null;
  const rxPct = data ? formatAirtimePercent(data.rx_airtime_seconds, data.uptime_seconds) : null;
  const rxPerMin = data ? formatPerMinute(data.packets_received, data.uptime_seconds) : null;
  const txPerMin = data ? formatPerMinute(data.packets_sent, data.uptime_seconds) : null;

  return (
    <RepeaterPane title={t`Telemetry`} state={state} onRefresh={onRefresh} disabled={disabled}>
      {!data ? (
        <NotFetched />
      ) : (
        <div className="space-y-2">
          <KvRow label={t`Battery`} value={`${data.battery_volts.toFixed(3)}V`} />
          <KvRow label={t`Uptime`} value={formatDuration(data.uptime_seconds)} />
          <KvRow
            label={t`TX Airtime`}
            value={
              <>
                {formatDuration(data.airtime_seconds)}
                {txPct && <Secondary>({txPct})</Secondary>}
              </>
            }
          />
          <KvRow
            label={t`RX Airtime`}
            value={
              <>
                {formatDuration(data.rx_airtime_seconds)}
                {rxPct && <Secondary>({rxPct})</Secondary>}
              </>
            }
          />
          <Separator className="my-1" />
          <KvRow label={t`Noise Floor`} value={`${data.noise_floor_dbm} dBm`} />
          <KvRow label={t`Last RSSI`} value={`${data.last_rssi_dbm} dBm`} />
          <KvRow label={t`Last SNR`} value={`${data.last_snr_db.toFixed(1)} dB`} />
          <Separator className="my-1" />
          <KvRow
            label={t`Packets`}
            value={
              <>
                {data.packets_received.toLocaleString(getLocale())} <Trans>rx / </Trans>
                {data.packets_sent.toLocaleString(getLocale())} <Trans>tx</Trans>
                {rxPerMin && txPerMin && (
                  <Secondary>
                    <Trans>
                      (avg {rxPerMin} rx/min / {txPerMin} tx/min)
                    </Trans>
                  </Secondary>
                )}
              </>
            }
          />
          <KvRow
            label={t`Flood`}
            value={`${data.recv_flood.toLocaleString(getLocale())} rx / ${data.sent_flood.toLocaleString(getLocale())} tx`}
          />
          <KvRow
            label={t`Direct`}
            value={`${data.recv_direct.toLocaleString(getLocale())} rx / ${data.sent_direct.toLocaleString(getLocale())} tx`}
          />
          <KvRow
            label={t`Duplicates`}
            value={`${data.flood_dups.toLocaleString(getLocale())} flood / ${data.direct_dups.toLocaleString(getLocale())} direct`}
          />
          {data.recv_errors != null && (
            <KvRow
              label={t`RX Errors`}
              value={
                <>
                  {data.recv_errors.toLocaleString(getLocale())}
                  {data.packets_received > 0 && (
                    <Secondary>
                      (
                      {(
                        (data.recv_errors / (data.packets_received + data.recv_errors)) *
                        100
                      ).toFixed(2)}
                      %)
                    </Secondary>
                  )}
                </>
              }
            />
          )}
          <Separator className="my-1" />
          <KvRow label={t`TX Queue`} value={data.tx_queue_len} />
          <KvRow label={t`Debug Flags`} value={data.full_events} />
        </div>
      )}
    </RepeaterPane>
  );
}
