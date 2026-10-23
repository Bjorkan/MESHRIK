import { getLocale } from '@/i18n';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useState, useEffect, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { toast } from '../ui/sonner';
import { api } from '../../api';
import { formatTime } from '../../utils/messageParser';
import { lppDisplayUnit } from '../repeater/repeaterPaneShared';
import { useDistanceUnit } from '../../contexts/DistanceUnitContext';
import { BulkDeleteContactsModal } from './BulkDeleteContactsModal';
import type {
  AppSettings,
  AppSettingsUpdate,
  Contact,
  TelemetryHistoryEntry,
  TelemetrySchedule,
} from '../../types';

export function SettingsRadioAppSection({
  appSettings,
  onSaveAppSettings,
  blockedKeys = [],
  blockedNames = [],
  onToggleBlockedKey,
  onToggleBlockedName,
  contacts = [],
  onBulkDeleteContacts,
  trackedTelemetryRepeaters = [],
  onToggleTrackedTelemetry,
  trackedTelemetryContacts = [],
  onToggleTrackedTelemetryContact,
  className,
}: {
  appSettings: AppSettings;
  onSaveAppSettings: (update: AppSettingsUpdate) => Promise<void>;
  blockedKeys?: string[];
  blockedNames?: string[];
  onToggleBlockedKey?: (key: string) => void;
  onToggleBlockedName?: (name: string) => void;
  contacts?: Contact[];
  onBulkDeleteContacts?: (deletedKeys: string[]) => void;
  trackedTelemetryRepeaters?: string[];
  onToggleTrackedTelemetry?: (publicKey: string) => Promise<void>;
  trackedTelemetryContacts?: string[];
  onToggleTrackedTelemetryContact?: (publicKey: string) => Promise<void>;
  className?: string;
}) {
  useLingui();

  const { distanceUnit } = useDistanceUnit();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const form = useForm({
    defaultValues: {
      discoveryBlockedTypes: appSettings.discovery_blocked_types ?? [],
      intervalDraft: appSettings.telemetry_interval_hours,
      telemetryRoutedHourly: appSettings.telemetry_routed_hourly,
    },
  });
  const { discoveryBlockedTypes, intervalDraft, telemetryRoutedHourly } = useStore(
    form.store,
    (state) => state.values
  );

  const [latestTelemetry, setLatestTelemetry] = useState<
    Record<string, TelemetryHistoryEntry | null>
  >({});
  const telemetryFetchedRef = useRef(false);

  const [latestContactTelemetry, setLatestContactTelemetry] = useState<
    Record<string, TelemetryHistoryEntry | null>
  >({});
  const contactTelemetryFetchedRef = useRef(false);

  const [schedule, setSchedule] = useState<TelemetrySchedule | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!form.getFieldMeta('discoveryBlockedTypes')?.isDirty) {
      form.setFieldValue('discoveryBlockedTypes', appSettings.discovery_blocked_types ?? []);
    }
    if (!form.getFieldMeta('intervalDraft')?.isDirty) {
      form.setFieldValue('intervalDraft', appSettings.telemetry_interval_hours);
    }
    if (!form.getFieldMeta('telemetryRoutedHourly')?.isDirty) {
      form.setFieldValue('telemetryRoutedHourly', appSettings.telemetry_routed_hourly);
    }
  }, [appSettings, form]);

  useEffect(() => {
    let cancelled = false;
    api
      .getTelemetrySchedule()
      .then((s) => {
        if (!cancelled) setSchedule(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    trackedTelemetryRepeaters.length,
    trackedTelemetryContacts.length,
    appSettings.telemetry_interval_hours,
    appSettings.telemetry_routed_hourly,
  ]);

  useEffect(() => {
    if (trackedTelemetryRepeaters.length === 0 || telemetryFetchedRef.current) return;
    telemetryFetchedRef.current = true;
    let cancelled = false;
    const fetches = trackedTelemetryRepeaters.map((key) =>
      api.repeaterTelemetryHistory(key).then(
        (history) => [key, history.length > 0 ? history[history.length - 1] : null] as const,
        () => [key, null] as const
      )
    );
    Promise.all(fetches).then((entries) => {
      if (cancelled) return;
      setLatestTelemetry(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [trackedTelemetryRepeaters]);

  useEffect(() => {
    if (trackedTelemetryContacts.length === 0 || contactTelemetryFetchedRef.current) return;
    contactTelemetryFetchedRef.current = true;
    let cancelled = false;
    const fetches = trackedTelemetryContacts.map((key) =>
      api.contactTelemetryHistory(key).then(
        (history) => [key, history.length > 0 ? history[history.length - 1] : null] as const,
        () => [key, null] as const
      )
    );
    Promise.all(fetches).then((entries) => {
      if (cancelled) return;
      setLatestContactTelemetry(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [trackedTelemetryContacts]);

  const persistAppSettings = (update: AppSettingsUpdate, revert: () => void): Promise<void> => {
    const chained = saveChainRef.current.then(async () => {
      try {
        await onSaveAppSettings(update);
      } catch (err) {
        console.error('Failed to save radio-app settings:', err);
        revert();
        toast.error(t`Failed to save setting`, {
          description: err instanceof Error ? err.message : t`Unknown error`,
        });
      }
    });
    saveChainRef.current = chained;
    return chained;
  };

  return (
    <div className={className}>
      {/* ── Tracked Repeater Telemetry ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Tracked Repeater Telemetry</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Repeaters opted into automatic telemetry collection are polled on a scheduled interval.
            To limit mesh traffic, the app caps telemetry at 24 checks per day across all tracked
            repeaters — so fewer tracked repeaters allows shorter intervals, and more tracked
            repeaters forces longer ones. Up to {schedule?.max_tracked ?? 8} repeaters may be
            tracked at once ({trackedTelemetryRepeaters.length} / {schedule?.max_tracked ?? 8} slots
            used).
          </Trans>
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="telemetry-interval" className="text-sm">
            <Trans>Collection interval</Trans>
          </Label>
          <div className="flex items-center gap-2">
            <select
              id="telemetry-interval"
              value={intervalDraft}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                if (!Number.isFinite(nextValue) || nextValue === intervalDraft) return;
                const prevValue = intervalDraft;
                form.setFieldValue('intervalDraft', nextValue);
                void persistAppSettings({ telemetry_interval_hours: nextValue }, () =>
                  form.setFieldValue('intervalDraft', prevValue)
                );
              }}
              className="h-9 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              {(schedule?.options ?? [1, 2, 3, 4, 6, 8, 12, 24]).map((hrs) => (
                <option key={hrs} value={hrs}>
                  <Trans>
                    Every {hrs} hour{hrs === 1 ? '' : 's'} ({Math.floor(24 / hrs)} check
                    {Math.floor(24 / hrs) === 1 ? '' : 's'}/day)
                  </Trans>
                </option>
              ))}
            </select>
          </div>
          {schedule && schedule.effective_hours !== schedule.preferred_hours && (
            <p className="text-xs text-warning">
              <Trans>
                Saved preference is {schedule.preferred_hours} hour
                {schedule.preferred_hours === 1 ? '' : 's'}, but the scheduler is using{' '}
                {schedule.effective_hours} hours because {schedule.tracked_count} repeater
                {schedule.tracked_count === 1 ? '' : 's'}{' '}
                {schedule.tracked_count === 1 ? 'is' : 'are'} tracked. Your preference will be
                restored if you drop back to a supported count.
              </Trans>
            </p>
          )}
        </div>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={telemetryRoutedHourly}
            onChange={() => {
              const next = !telemetryRoutedHourly;
              form.setFieldValue('telemetryRoutedHourly', next);
              void persistAppSettings({ telemetry_routed_hourly: next }, () =>
                form.setFieldValue('telemetryRoutedHourly', !next)
              );
            }}
            className="w-4 h-4 rounded border-input accent-primary mt-0.5"
          />
          <div>
            <span className="text-sm">
              <Trans>Poll direct/routed-path repeaters hourly</Trans>
            </span>
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>
                When enabled, tracked repeaters with a direct or routed path (not flood) are polled
                every hour instead of on the scheduled interval above. Flood-only repeaters still
                follow the normal schedule.
              </Trans>
            </p>
          </div>
        </label>

        {schedule?.next_run_at != null && (
          <p className="text-xs text-muted-foreground">
            <Trans>
              {schedule.routed_hourly ? t`Next flood run at` : t`Next run at`}{' '}
              {formatTime(schedule.next_run_at)} (UTC top of hour).
            </Trans>
          </p>
        )}
        {schedule?.next_routed_run_at != null && (
          <p className="text-xs text-muted-foreground">
            <Trans>
              Next direct/routed run at {formatTime(schedule.next_routed_run_at)} (UTC top of hour).
            </Trans>
          </p>
        )}

        {trackedTelemetryRepeaters.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            <Trans>
              No repeaters are being tracked. Enable tracking from a repeater's dashboard.
            </Trans>
          </p>
        ) : (
          <div className="space-y-2">
            {trackedTelemetryRepeaters.map((key) => {
              const contact = contacts.find((c) => c.public_key === key);
              const displayName = contact?.name ?? key.slice(0, 12);
              const routeSource = contact?.effective_route_source ?? 'flood';
              const hasRealPath =
                contact?.effective_route != null && contact.effective_route.path_len >= 0;
              const routeLabel = !hasRealPath
                ? 'flood'
                : routeSource === 'override'
                  ? 'routed'
                  : routeSource === 'direct'
                    ? 'direct'
                    : 'flood';
              const routeColor = hasRealPath
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground bg-muted';
              const snap = latestTelemetry[key];
              const d = snap?.data;
              return (
                <div key={key} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">{displayName}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[0.625rem] text-muted-foreground font-mono">
                          {key.slice(0, 12)}
                        </span>
                        <span
                          className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium ${routeColor}`}
                        >
                          {routeLabel}
                        </span>
                      </div>
                    </div>
                    {onToggleTrackedTelemetry && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onToggleTrackedTelemetry(key)}
                        className="h-7 text-xs flex-shrink-0 text-destructive hover:text-destructive"
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    )}
                  </div>
                  {d ? (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.625rem] text-muted-foreground">
                      <span>
                        <Trans>{d.battery_volts?.toFixed(2)}V</Trans>
                      </span>
                      <span>
                        <Trans>noise {d.noise_floor_dbm} dBm</Trans>
                      </span>
                      <span>
                        <Trans>
                          rx{' '}
                          {d.packets_received != null
                            ? d.packets_received.toLocaleString(getLocale())
                            : '?'}
                        </Trans>
                      </span>
                      <span>
                        <Trans>
                          tx{' '}
                          {d.packets_sent != null
                            ? d.packets_sent.toLocaleString(getLocale())
                            : '?'}
                        </Trans>
                      </span>
                      {d.lpp_sensors?.map((s) => {
                        const display = lppDisplayUnit(s.type_name, s.value, distanceUnit);
                        const val =
                          typeof display.value === 'number'
                            ? display.value % 1 === 0
                              ? display.value
                              : display.value.toFixed(1)
                            : display.value;
                        const label = s.type_name.charAt(0).toUpperCase() + s.type_name.slice(1);
                        return (
                          <span key={`${s.type_name}-${s.channel}`}>
                            {label} {val}
                            {display.unit ? t` ${display.unit}` : ''}
                          </span>
                        );
                      })}
                      <span className="ml-auto">
                        <Trans>checked {formatTime(snap.timestamp)}</Trans>
                      </span>
                    </div>
                  ) : snap === null ? (
                    <div className="mt-1 text-[0.625rem] text-muted-foreground italic">
                      <Trans>No telemetry recorded yet</Trans>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      {/* ── Tracked Contact Telemetry ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Tracked Contact Telemetry</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Non-repeater contacts (companions, rooms, sensors) can also be tracked for periodic LPP
            telemetry collection (battery, sensors, GPS). Up to 8 contacts may be tracked. The daily
            check ceiling is shared with tracked repeaters — adding contacts may clamp the interval
            upward.
          </Trans>
        </p>

        {trackedTelemetryContacts.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            <Trans>
              No contacts are being tracked. Enable tracking from a contact&apos;s info pane.
            </Trans>
          </p>
        ) : (
          <div className="space-y-2">
            {trackedTelemetryContacts.map((key) => {
              const contact = contacts.find((c) => c.public_key === key);
              const displayName = contact?.name ?? key.slice(0, 12);
              const routeSource = contact?.effective_route_source ?? 'flood';
              const hasRealPath =
                contact?.effective_route != null && contact.effective_route.path_len >= 0;
              const routeLabel = !hasRealPath
                ? 'flood'
                : routeSource === 'override'
                  ? 'routed'
                  : routeSource === 'direct'
                    ? 'direct'
                    : 'flood';
              const routeColor = hasRealPath
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground bg-muted';
              const snap = latestContactTelemetry[key];
              const d = snap?.data;
              return (
                <div key={key} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">{displayName}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[0.625rem] text-muted-foreground font-mono">
                          {key.slice(0, 12)}
                        </span>
                        <span
                          className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium ${routeColor}`}
                        >
                          {routeLabel}
                        </span>
                      </div>
                    </div>
                    {onToggleTrackedTelemetryContact && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onToggleTrackedTelemetryContact(key)}
                        className="h-7 text-xs flex-shrink-0 text-destructive hover:text-destructive"
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    )}
                  </div>
                  {d ? (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.625rem] text-muted-foreground">
                      {d.lpp_sensors?.map((s) => {
                        if (typeof s.value !== 'number') return null;
                        const display = lppDisplayUnit(s.type_name, s.value, distanceUnit);
                        const val =
                          typeof display.value === 'number'
                            ? display.value % 1 === 0
                              ? display.value
                              : display.value.toFixed(1)
                            : display.value;
                        const label = s.type_name.charAt(0).toUpperCase() + s.type_name.slice(1);
                        return (
                          <span key={`${s.type_name}-${s.channel}`}>
                            {label} {val}
                            {display.unit ? t` ${display.unit}` : ''}
                          </span>
                        );
                      })}
                      <span className="ml-auto">
                        <Trans>checked {formatTime(snap.timestamp)}</Trans>
                      </span>
                    </div>
                  ) : snap === null ? (
                    <div className="mt-1 text-[0.625rem] text-muted-foreground italic">
                      <Trans>No telemetry recorded yet</Trans>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      {/* ── Contact Management ── */}
      <div className="space-y-5">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Contact Management</Trans>
        </h3>

        <div className="space-y-3">
          <h4 className="text-sm font-semibold">
            <Trans>Block Discovery of New Node Types</Trans>
          </h4>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Checked types will be ignored when heard via advertisement. Existing contacts of these
              types are still updated. This does not affect contacts added manually or via DM.
            </Trans>
          </p>
          <div className="space-y-1.5">
            {(
              [
                [1, 'Block clients'],
                [2, 'Block repeaters'],
                [3, 'Block room servers'],
                [4, 'Block sensors'],
              ] as const
            ).map(([typeCode, label]) => {
              const checked = discoveryBlockedTypes.includes(typeCode);
              return (
                <label key={typeCode} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const prev = discoveryBlockedTypes;
                      const next = checked
                        ? prev.filter((t) => t !== typeCode)
                        : [...prev, typeCode];
                      form.setFieldValue('discoveryBlockedTypes', next);
                      void persistAppSettings({ discovery_blocked_types: next }, () =>
                        form.setFieldValue('discoveryBlockedTypes', prev)
                      );
                    }}
                    className="rounded border-input"
                  />
                  {label}
                </label>
              );
            })}
          </div>
          {discoveryBlockedTypes.length > 0 && (
            <p className="text-xs text-warning">
              <Trans>
                New{' '}
                {discoveryBlockedTypes
                  .map((t) =>
                    t === 1
                      ? 'clients'
                      : t === 2
                        ? 'repeaters'
                        : t === 3
                          ? 'room servers'
                          : 'sensors'
                  )
                  .join(', ')}{' '}
                heard via advertisement will not be added to your contact list.
              </Trans>
            </p>
          )}
        </div>

        <div className="space-y-3">
          <h4 className="text-sm font-semibold">
            <Trans>Blocked Contacts</Trans>
          </h4>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Blocked contacts are hidden from the sidebar. Blocking only hides messages from the UI
              — MQTT forwarding and bot responses are not affected. Messages are still stored and
              will reappear if unblocked.
            </Trans>
          </p>

          {blockedKeys.length === 0 && blockedNames.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              <Trans>
                No blocked contacts. Block contacts from their info pane, viewed by clicking their
                avatar in any channel, or their name within the top status bar with the conversation
                open.
              </Trans>
            </p>
          ) : (
            <div className="space-y-2">
              {blockedKeys.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground font-medium">
                    <Trans>Blocked Keys</Trans>
                  </span>
                  <div className="mt-1 space-y-1">
                    {blockedKeys.map((key) => (
                      <div key={key} className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono truncate flex-1">{key}</span>
                        {onToggleBlockedKey && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onToggleBlockedKey(key)}
                            className="h-7 text-xs flex-shrink-0"
                          >
                            <Trans>Unblock</Trans>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {blockedNames.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground font-medium">
                    <Trans>Blocked Names</Trans>
                  </span>
                  <div className="mt-1 space-y-1">
                    {blockedNames.map((name) => (
                      <div key={name} className="flex items-center justify-between gap-2">
                        <span className="text-sm truncate flex-1">{name}</span>
                        {onToggleBlockedName && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onToggleBlockedName(name)}
                            className="h-7 text-xs flex-shrink-0"
                          >
                            <Trans>Unblock</Trans>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h4 className="text-sm font-semibold">
            <Trans>Bulk Delete Contacts</Trans>
          </h4>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Remove multiple contacts or repeaters at once. Useful for cleaning up spam or unwanted
              nodes. Message history will be preserved.
            </Trans>
          </p>
          <Button variant="outline" className="w-full" onClick={() => setBulkDeleteOpen(true)}>
            <Trans>Open Bulk Delete</Trans>
          </Button>
          <BulkDeleteContactsModal
            open={bulkDeleteOpen}
            onClose={() => setBulkDeleteOpen(false)}
            contacts={contacts}
            onDeleted={(keys) => onBulkDeleteContacts?.(keys)}
          />
        </div>
      </div>
    </div>
  );
}
