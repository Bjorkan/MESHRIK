import { useState, useCallback, useEffect, useRef, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../queryClient';
import { toast } from '../components/ui/sonner';
import type {
  HealthStatus,
  RadioAdvertMode,
  RadioConfigUpdate,
  RadioDiscoveryResponse,
  RadioDiscoveryTarget,
  RadioRegionDiscoveryResponse,
} from '../types';

export function useRadioControl() {
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health(),
    queryFn: api.getHealth,
  });
  const configQuery = useQuery({
    queryKey: queryKeys.radioConfig(),
    queryFn: api.getRadioConfig,
  });
  const health = healthQuery.data ?? null;
  const config = configQuery.data ?? null;
  const [meshDiscovery, setMeshDiscovery] = useState<RadioDiscoveryResponse | null>(null);
  const [meshDiscoveryLoadingTarget, setMeshDiscoveryLoadingTarget] =
    useState<RadioDiscoveryTarget | null>(null);
  const [regionDiscovery, setRegionDiscovery] = useState<RadioRegionDiscoveryResponse | null>(null);
  const [regionDiscoveryLoading, setRegionDiscoveryLoading] = useState(false);

  const prevHealthRef = useRef<HealthStatus | null>(null);
  const rebootPollTokenRef = useRef(0);

  // Cancel any in-flight reboot polling on unmount
  useEffect(() => {
    return () => {
      rebootPollTokenRef.current += 1;
    };
  }, []);

  const setHealth = useCallback(
    (update: SetStateAction<HealthStatus | null>) => {
      queryClient.setQueryData<HealthStatus | null>(queryKeys.health(), (previous = null) =>
        typeof update === 'function'
          ? (update as (value: HealthStatus | null) => HealthStatus | null)(previous)
          : update
      );
    },
    [queryClient]
  );

  const fetchConfig = useCallback(async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.radioConfig() });
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  }, [queryClient]);

  const handleSaveConfig = useCallback(
    async (update: RadioConfigUpdate) => {
      const updated = await api.updateRadioConfig(update);
      queryClient.setQueryData(queryKeys.radioConfig(), updated);
    },
    [queryClient]
  );

  const handleSetPrivateKey = useCallback(
    async (key: string) => {
      await api.setPrivateKey(key);
      await fetchConfig();
    },
    [fetchConfig]
  );

  const handleReboot = useCallback(async () => {
    await api.rebootRadio();
    setHealth((prev) =>
      prev ? { ...prev, radio_connected: false, radio_initializing: false } : prev
    );
    const pollToken = ++rebootPollTokenRef.current;
    const pollUntilReconnected = async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (rebootPollTokenRef.current !== pollToken) return;
        try {
          const data = await api.getHealth();
          if (rebootPollTokenRef.current !== pollToken) return;
          setHealth(data);
          if (data.radio_connected) {
            fetchConfig();
            return;
          }
        } catch {
          // Keep polling
        }
      }
    };
    pollUntilReconnected();
  }, [fetchConfig, setHealth]);

  const handleDisconnect = useCallback(async () => {
    await api.disconnectRadio();
    const pausedHealth = await api.getHealth();
    setHealth(pausedHealth);
  }, [setHealth]);

  const handleReconnect = useCallback(async () => {
    await api.reconnectRadio();
    const refreshedHealth = await api.getHealth();
    setHealth(refreshedHealth);
    if (refreshedHealth.radio_connected) {
      await fetchConfig();
    }
  }, [fetchConfig, setHealth]);

  const handleAdvertise = useCallback(async (mode: RadioAdvertMode = 'flood') => {
    try {
      await api.sendAdvertisement(mode);
      toast.success(mode === 'zero_hop' ? 'Zero-hop advertisement sent' : 'Advertisement sent');
    } catch (err) {
      const label = mode === 'zero_hop' ? 'zero-hop advertisement' : 'advertisement';
      console.error(`Failed to send ${label}:`, err);
      toast.error(`Failed to send ${label}`, {
        description: err instanceof Error ? err.message : 'Check radio connection',
      });
    }
  }, []);

  const handleDiscoverMesh = useCallback(async (target: RadioDiscoveryTarget) => {
    setMeshDiscoveryLoadingTarget(target);
    try {
      const data = await api.discoverMesh(target);
      setMeshDiscovery(data);
      toast.success(
        data.results.length === 0
          ? 'No nearby nodes responded'
          : `Found ${data.results.length} nearby node${data.results.length === 1 ? '' : 's'}`
      );
    } catch (err) {
      console.error('Failed to discover nearby nodes:', err);
      toast.error('Failed to run mesh discovery', {
        description: err instanceof Error ? err.message : 'Check radio connection',
      });
    } finally {
      setMeshDiscoveryLoadingTarget(null);
    }
  }, []);

  const handleDiscoverRegions = useCallback(async (publicKeys?: string[]) => {
    setRegionDiscoveryLoading(true);
    try {
      const data = await api.discoverRegions(publicKeys);
      setRegionDiscovery(data);
      if (data.repeaters_queried === 0) {
        toast.info('No repeaters available to query for regions');
      } else if (data.regions.length === 0) {
        toast.info(
          `No regions reported (${data.repeaters_answered}/${data.repeaters_queried} repeaters answered)`
        );
      } else {
        toast.success(
          `Found ${data.regions.length} region${data.regions.length === 1 ? '' : 's'} from ${data.repeaters_answered}/${data.repeaters_queried} repeaters`
        );
      }
    } catch (err) {
      console.error('Failed to discover regions:', err);
      toast.error('Failed to discover regions', {
        description: err instanceof Error ? err.message : 'Check radio connection',
      });
    } finally {
      setRegionDiscoveryLoading(false);
    }
  }, []);

  const handleHealthRefresh = useCallback(async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.health() });
    } catch (err) {
      console.error('Failed to refresh health:', err);
    }
  }, [queryClient]);

  return {
    health,
    setHealth,
    config,
    prevHealthRef,
    fetchConfig,
    handleSaveConfig,
    handleSetPrivateKey,
    handleReboot,
    handleDisconnect,
    handleReconnect,
    handleAdvertise,
    meshDiscovery,
    meshDiscoveryLoadingTarget,
    handleDiscoverMesh,
    regionDiscovery,
    regionDiscoveryLoading,
    handleDiscoverRegions,
    handleHealthRefresh,
  };
}
