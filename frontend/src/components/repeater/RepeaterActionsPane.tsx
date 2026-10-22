import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useState, useCallback, useEffect } from 'react';
import { Button } from '../ui/button';
import { LoadingIndicator } from '../ui/loading-indicator';
import type { RepeaterPendingAction } from '../../hooks/useRepeaterDashboard';

export function ActionsPane({
  onSendZeroHopAdvert,
  onSendFloodAdvert,
  onSyncClock,
  onReboot,
  consoleLoading,
  pendingAction,
}: {
  onSendZeroHopAdvert: () => void;
  onSendFloodAdvert: () => void;
  onSyncClock: () => void;
  onReboot: () => void;
  consoleLoading: boolean;
  pendingAction?: RepeaterPendingAction | null;
}) {
  useLingui();

  const [confirmReboot, setConfirmReboot] = useState(false);

  const handleReboot = useCallback(() => {
    if (!confirmReboot) {
      setConfirmReboot(true);
      return;
    }
    setConfirmReboot(false);
    onReboot();
  }, [confirmReboot, onReboot]);

  // Reset confirmation after 3 seconds
  useEffect(() => {
    if (!confirmReboot) return;
    const timer = setTimeout(() => setConfirmReboot(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmReboot]);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-muted/50 border-b border-border">
        <h3 className="text-sm font-medium">
          <Trans>Actions</Trans>
        </h3>
      </div>
      <div className="p-3 flex flex-wrap gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal">
        <Button variant="outline" size="sm" onClick={onSendZeroHopAdvert} disabled={consoleLoading}>
          {pendingAction === 'zero-hop-advert' ? (
            <LoadingIndicator label={t`Requesting zero-hop advert...`} />
          ) : (
            t`Zero Hop Advert`
          )}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onSendFloodAdvert}
          disabled={consoleLoading}
        >
          {pendingAction === 'flood-advert' ? (
            <LoadingIndicator label={t`Requesting flood advert...`} />
          ) : (
            t`Flood Advert`
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onSyncClock} disabled={consoleLoading}>
          {pendingAction === 'clock' ? (
            <LoadingIndicator label={t`Requesting clock sync...`} />
          ) : (
            t`Sync Clock`
          )}
        </Button>
        <Button
          variant={confirmReboot ? `destructive` : `outline`}
          size="sm"
          onClick={handleReboot}
          disabled={consoleLoading}
        >
          {pendingAction === 'reboot' ? (
            <LoadingIndicator label={t`Requesting reboot...`} />
          ) : confirmReboot ? (
            t`Confirm Reboot`
          ) : (
            t`Reboot`
          )}
        </Button>
      </div>
      {consoleLoading && (
        <p className="px-3 pb-3 text-sm text-muted-foreground">
          {pendingAction === 'console' || !pendingAction ? (
            <LoadingIndicator label={t`Waiting for console command...`} />
          ) : (
            t`Other actions are unavailable while this command is pending.`
          )}
        </p>
      )}
    </div>
  );
}
