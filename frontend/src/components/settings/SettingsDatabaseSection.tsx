import { useEffect, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useMutation } from '@tanstack/react-query';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { toast } from '../ui/sonner';
import { api } from '../../api';
import { formatTime } from '../../utils/messageParser';
import type { AppSettings, AppSettingsUpdate, HealthStatus } from '../../types';

export function SettingsDatabaseSection({
  appSettings,
  health,
  onSaveAppSettings,
  onHealthRefresh,
  className,
}: {
  appSettings: AppSettings;
  health: HealthStatus | null;
  onSaveAppSettings: (update: AppSettingsUpdate) => Promise<void>;
  onHealthRefresh: () => Promise<void>;
  className?: string;
}) {
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const maintenanceSubmitRef = useRef(false);
  const maintenanceMutation = useMutation({
    mutationFn: (action: { kind: 'cleanup'; days: number } | { kind: 'purge' }) =>
      action.kind === 'cleanup'
        ? api.runMaintenance({ pruneUndecryptedDays: action.days })
        : api.runMaintenance({ purgeLinkedRawPackets: true }),
    retry: false,
    onSuccess: async (result, action) => {
      if (action.kind === 'cleanup') {
        toast.success('Database cleanup complete', {
          description: `Deleted ${result.packets_deleted} old packet${result.packets_deleted === 1 ? '' : 's'}`,
        });
      } else {
        toast.success('Decrypted raw packets purged', {
          description: `Deleted ${result.packets_deleted} raw packet${result.packets_deleted === 1 ? '' : 's'}`,
        });
      }
      await onHealthRefresh();
    },
    onError: (err, action) => {
      console.error(
        action.kind === 'cleanup'
          ? 'Failed to run maintenance:'
          : 'Failed to purge decrypted raw packets:',
        err
      );
      toast.error(
        action.kind === 'cleanup'
          ? 'Database cleanup failed'
          : 'Failed to purge decrypted raw packets',
        { description: err instanceof Error ? err.message : 'Unknown error' }
      );
    },
  });
  const form = useForm({
    defaultValues: {
      retentionDays: '14',
      autoDecryptOnAdvert: appSettings.auto_decrypt_dm_on_advert,
      action: null as 'cleanup' | 'purge' | null,
      retentionError: '',
    },
    onSubmit: async ({ value }) => {
      if (value.action === 'cleanup') {
        const days = Number(value.retentionDays);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          form.setFieldValue('retentionError', 'Retention days must be a whole number from 1–365');
          return;
        }
        form.setFieldValue('retentionError', '');
        await maintenanceMutation.mutateAsync({ kind: 'cleanup', days }).catch(() => undefined);
        return;
      }

      if (value.action === 'purge') {
        await maintenanceMutation.mutateAsync({ kind: 'purge' }).catch(() => undefined);
      }
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const { retentionDays, autoDecryptOnAdvert, retentionError } = values;
  const cleaning = isSubmitting && values.action === 'cleanup';
  const purgingDecryptedRaw = isSubmitting && values.action === 'purge';
  const maintenanceBusy = isSubmitting || maintenanceMutation.isPending;

  const submitMaintenance = (action: 'cleanup' | 'purge') => {
    if (maintenanceSubmitRef.current) return;
    maintenanceSubmitRef.current = true;
    form.setFieldValue('action', action);
    void form.handleSubmit().finally(() => {
      maintenanceSubmitRef.current = false;
      form.setFieldValue('action', null);
    });
  };

  useEffect(() => {
    if (form.getFieldMeta('autoDecryptOnAdvert')?.isDirty) return;
    form.setFieldValue('autoDecryptOnAdvert', appSettings.auto_decrypt_dm_on_advert);
  }, [appSettings.auto_decrypt_dm_on_advert, form]);

  const persistAppSettings = (update: AppSettingsUpdate, revert: () => void): Promise<void> => {
    const chained = saveChainRef.current.then(async () => {
      try {
        await onSaveAppSettings(update);
      } catch (err) {
        console.error('Failed to save database settings:', err);
        revert();
        toast.error('Failed to save setting', {
          description: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    });
    saveChainRef.current = chained;
    return chained;
  };

  return (
    <div className={className}>
      {/* ── Database Overview ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">Database Overview</h3>
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm">Database size</span>
            <span className="text-sm font-semibold">{health?.database_size_mb ?? '?'} MB</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm">Oldest undecrypted packet</span>
            {health?.oldest_undecrypted_timestamp ? (
              <span className="text-sm font-semibold">
                {formatTime(health.oldest_undecrypted_timestamp)}
                <span className="font-normal text-muted-foreground ml-1">
                  ({Math.floor((Date.now() / 1000 - health.oldest_undecrypted_timestamp) / 86400)}{' '}
                  days)
                </span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">None</span>
            )}
          </div>
        </div>
      </div>

      <Separator />

      {/* ── Storage Cleanup ── */}
      <div className="space-y-4">
        <h3 className="text-base font-semibold tracking-tight">Storage Cleanup</h3>

        <div className="rounded-md border border-border p-3 space-y-2">
          <h3 className="text-sm font-semibold">Delete Undecrypted Packets</h3>
          <p className="text-[0.8125rem] text-muted-foreground">
            Permanently deletes stored raw packets that have not yet been decrypted. These are
            retained in case you later obtain the correct key — once deleted, these messages can
            never be recovered.
          </p>
          <div className="flex gap-2 items-end">
            <div className="space-y-1">
              <Label htmlFor="retention-days" className="text-xs text-muted-foreground">
                Older than (days)
              </Label>
              <Input
                id="retention-days"
                type="number"
                min="1"
                max="365"
                value={retentionDays}
                onChange={(e) => form.setFieldValue('retentionDays', e.target.value)}
                className="w-24"
                aria-invalid={retentionError ? true : undefined}
                aria-describedby={retentionError ? 'retention-days-error' : undefined}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                if (
                  !window.confirm(
                    `Permanently delete undecrypted packets older than ${retentionDays || '?'} days?`
                  )
                ) {
                  return;
                }
                submitMaintenance('cleanup');
              }}
              disabled={maintenanceBusy}
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
            >
              {cleaning ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
          {retentionError && (
            <p id="retention-days-error" className="text-xs text-destructive" role="alert">
              {retentionError}
            </p>
          )}
        </div>

        <div className="rounded-md border border-border p-3 space-y-2">
          <h3 className="text-sm font-semibold">Purge Archival Raw Packets</h3>
          <p className="text-[0.8125rem] text-muted-foreground">
            Deletes the raw packet bytes behind messages that are already decrypted and visible in
            chat. This frees space but removes packet-analysis availability for those messages. It
            does not affect displayed messages or future decryption.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              if (
                !window.confirm('Permanently purge raw packet bytes linked to decrypted messages?')
              ) {
                return;
              }
              submitMaintenance('purge');
            }}
            disabled={maintenanceBusy}
            className="w-full border-warning/50 text-warning hover:bg-warning/10"
          >
            {purgingDecryptedRaw ? 'Purging...' : 'Purge Archival Packets'}
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── DM Decryption ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">DM Decryption</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autoDecryptOnAdvert}
            onChange={(e) => {
              const next = e.target.checked;
              const prev = autoDecryptOnAdvert;
              form.setFieldValue('autoDecryptOnAdvert', next);
              void persistAppSettings({ auto_decrypt_dm_on_advert: next }, () =>
                form.setFieldValue('autoDecryptOnAdvert', prev)
              );
            }}
            className="w-4 h-4 rounded border-input accent-primary"
          />
          <span className="text-sm">Auto-decrypt historical DMs when new contact advertises</span>
        </label>
        <p className="text-[0.8125rem] text-muted-foreground">
          When enabled, the server will automatically try to decrypt stored DM packets when a new
          contact sends an advertisement. This may cause brief delays on large packet backlogs.
        </p>
      </div>
    </div>
  );
}
