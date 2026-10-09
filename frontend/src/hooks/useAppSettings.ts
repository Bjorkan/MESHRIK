import { useCallback, useEffect, useRef, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { takePrefetchOrFetch } from '../prefetch';
import { queryKeys } from '../queryClient';
import { toast } from '../components/ui/sonner';
import { initLastMessageTimes } from '../utils/conversationState';
import type { AppSettings, AppSettingsUpdate } from '../types';

export function useAppSettings() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: ({ signal }) => takePrefetchOrFetch('settings', () => api.getSettings(signal)),
  });
  const appSettings = settingsQuery.data ?? null;

  // One-time migration guard
  const hasMigratedRef = useRef(false);

  useEffect(() => {
    if (settingsQuery.error) {
      console.error('Failed to fetch app settings:', settingsQuery.error);
    }
  }, [settingsQuery.error]);

  useEffect(() => {
    if (appSettings) {
      initLastMessageTimes(appSettings.last_message_times ?? {});
    }
  }, [appSettings]);

  const setAppSettings = useCallback(
    (update: SetStateAction<AppSettings | null>) => {
      void queryClient.cancelQueries({ queryKey: queryKeys.settings() });
      queryClient.setQueryData<AppSettings | null>(queryKeys.settings(), (previous = null) =>
        typeof update === 'function' ? update(previous) : update
      );
    },
    [queryClient]
  );

  const refreshAppSettings = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
    [queryClient]
  );

  const saveSettingsMutation = useMutation({
    mutationFn: (update: AppSettingsUpdate) => api.updateSettings(update),
    retry: false,
    onSuccess: (updated) => setAppSettings(updated),
  });

  const handleSaveAppSettings = useCallback(
    async (update: AppSettingsUpdate) => {
      await saveSettingsMutation.mutateAsync(update);
    },
    [saveSettingsMutation]
  );

  const handleToggleBlockedKey = useCallback(
    async (key: string) => {
      const normalizedKey = key.toLowerCase();
      setAppSettings((prev) => {
        if (!prev) return prev;
        const current = prev.blocked_keys ?? [];
        const wasBlocked = current.includes(normalizedKey);
        const optimistic = wasBlocked
          ? current.filter((k) => k !== normalizedKey)
          : [...current, normalizedKey];
        return { ...prev, blocked_keys: optimistic };
      });

      try {
        const updatedSettings = await api.toggleBlockedKey(key);
        setAppSettings(updatedSettings);
      } catch (err) {
        console.error('Failed to toggle blocked key:', err);
        try {
          const settings = await api.getSettings();
          setAppSettings(settings);
        } catch {
          // If refetch also fails, leave optimistic state
        }
        toast.error('Failed to update blocked key');
      }
    },
    [setAppSettings]
  );

  const handleToggleBlockedName = useCallback(
    async (name: string) => {
      setAppSettings((prev) => {
        if (!prev) return prev;
        const current = prev.blocked_names ?? [];
        const wasBlocked = current.includes(name);
        const optimistic = wasBlocked ? current.filter((n) => n !== name) : [...current, name];
        return { ...prev, blocked_names: optimistic };
      });

      try {
        const updatedSettings = await api.toggleBlockedName(name);
        setAppSettings(updatedSettings);
      } catch (err) {
        console.error('Failed to toggle blocked name:', err);
        try {
          const settings = await api.getSettings();
          setAppSettings(settings);
        } catch {
          // If refetch also fails, leave optimistic state
        }
        toast.error('Failed to update blocked name');
      }
    },
    [setAppSettings]
  );

  const handleToggleTrackedTelemetry = useCallback(
    async (publicKey: string) => {
      const key = publicKey.toLowerCase();
      setAppSettings((prev) => {
        if (!prev) return prev;
        const current = prev.tracked_telemetry_repeaters ?? [];
        const wasTracked = current.includes(key);
        const optimistic = wasTracked ? current.filter((k) => k !== key) : [...current, key];
        return { ...prev, tracked_telemetry_repeaters: optimistic };
      });

      try {
        const result = await api.toggleTrackedTelemetry(publicKey);
        setAppSettings((prev) =>
          prev ? { ...prev, tracked_telemetry_repeaters: result.tracked_telemetry_repeaters } : prev
        );
      } catch (err) {
        console.error('Failed to toggle tracked telemetry:', err);
        try {
          const settings = await api.getSettings();
          setAppSettings(settings);
        } catch {
          // If refetch also fails, leave optimistic state
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = (err as any)?.body?.detail;
        if (typeof detail === 'object' && detail?.message) {
          toast.error(detail.message);
        } else {
          toast.error('Failed to update tracked telemetry');
        }
      }
    },
    [setAppSettings]
  );

  const handleToggleTrackedTelemetryContact = useCallback(
    async (publicKey: string) => {
      const key = publicKey.toLowerCase();
      setAppSettings((prev) => {
        if (!prev) return prev;
        const current = prev.tracked_telemetry_contacts ?? [];
        const wasTracked = current.includes(key);
        const optimistic = wasTracked ? current.filter((k) => k !== key) : [...current, key];
        return { ...prev, tracked_telemetry_contacts: optimistic };
      });

      try {
        const result = await api.toggleTrackedTelemetryContact(publicKey);
        setAppSettings((prev) =>
          prev ? { ...prev, tracked_telemetry_contacts: result.tracked_telemetry_contacts } : prev
        );
      } catch (err) {
        console.error('Failed to toggle tracked contact telemetry:', err);
        try {
          const settings = await api.getSettings();
          setAppSettings(settings);
        } catch {
          // If refetch also fails, leave optimistic state
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = (err as any)?.body?.detail;
        if (typeof detail === 'object' && detail?.message) {
          toast.error(detail.message);
        } else {
          toast.error('Failed to update tracked contact telemetry');
        }
      }
    },
    [setAppSettings]
  );

  // Legacy favorites migration: if pre-server-side favorites exist in
  // localStorage, toggle each one via the existing API and clear the key.
  useEffect(() => {
    if (!appSettings || hasMigratedRef.current) return;
    hasMigratedRef.current = true;

    const FAVORITES_KEY = 'meshrik-favorites';
    let localFavorites: Array<{ type: 'channel' | 'contact'; id: string }> = [];
    try {
      const stored = localStorage.getItem(FAVORITES_KEY);
      if (stored) localFavorites = JSON.parse(stored);
    } catch {
      // corrupt or unavailable
    }
    if (localFavorites.length === 0) return;

    const migrate = async () => {
      let migrated = 0;
      for (const f of localFavorites) {
        try {
          await api.toggleFavorite(f.type, f.id);
          migrated++;
        } catch {
          // Entity may have been deleted; skip and continue
        }
      }
      localStorage.removeItem(FAVORITES_KEY);
      // Reload so contacts/channels pick up the new favorite flags
      if (migrated > 0) window.location.reload();
    };
    migrate();
  }, [appSettings]);

  return {
    appSettings,
    refreshAppSettings,
    handleSaveAppSettings,
    handleToggleBlockedKey,
    handleToggleBlockedName,
    handleToggleTrackedTelemetry,
    handleToggleTrackedTelemetryContact,
  };
}
