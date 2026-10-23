import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Button } from './ui/button';
import type { ServerLoginAttemptState } from '../utils/serverLoginState';
import { getServerLoginAttemptTone } from '../utils/serverLoginState';
import { cn } from '../lib/utils';

interface ServerLoginStatusBannerProps {
  attempt: ServerLoginAttemptState | null;
  loading: boolean;
  canRetryPassword: boolean;
  onRetryPassword: () => Promise<void> | void;
  onRetryBlank: () => Promise<void> | void;
  passwordRetryLabel?: string;
  blankRetryLabel?: string;
  showRetryActions?: boolean;
}

export function ServerLoginStatusBanner({
  attempt,
  loading,
  canRetryPassword,
  onRetryPassword,
  onRetryBlank,
  passwordRetryLabel = 'Retry Password Login',
  blankRetryLabel = 'Retry Existing-Access Login',
  showRetryActions = true,
}: ServerLoginStatusBannerProps) {
  useLingui();

  if ((!attempt && !loading) || attempt?.outcome === 'confirmed') {
    return null;
  }

  const tone = loading ? 'muted' : getServerLoginAttemptTone(attempt);
  const shouldShowActions = showRetryActions;
  const toneClassName =
    tone === 'success'
      ? 'border-success/30 bg-success/10 text-success'
      : tone === 'warning'
        ? 'border-warning/30 bg-warning/10 text-warning'
        : tone === 'destructive'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/40 text-foreground';

  return (
    <div
      className={cn('rounded-md border px-4 py-3', toneClassName)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {loading
              ? t`Login request is still pending.`
              : (attempt?.summary ??
                t`No server login attempt has been recorded in this view yet.`)}
          </p>
          {loading ? (
            <p className="text-xs opacity-90">
              <Trans>
                Waiting for the server response. Navigation will not cancel or resend this attempt.
              </Trans>
            </p>
          ) : (
            attempt?.details && <p className="text-xs opacity-90">{attempt.details}</p>
          )}
        </div>
        {shouldShowActions ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onRetryPassword()}
              disabled={loading || !canRetryPassword}
            >
              {passwordRetryLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onRetryBlank()}
              disabled={loading}
            >
              {blankRetryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
