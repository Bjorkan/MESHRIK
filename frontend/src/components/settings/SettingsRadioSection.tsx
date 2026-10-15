import { useState, useEffect, useMemo, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Download, MapPinned, Upload } from 'lucide-react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { toast } from '../ui/sonner';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { api } from '../../api';
import { RADIO_PRESETS } from '../../utils/radioPresets';
import { stripRegionScopePrefix } from '../../utils/regionScope';
import type {
  AppSettings,
  AppSettingsUpdate,
  HealthStatus,
  RadioAdvertMode,
  RadioConfig,
  RadioConfigUpdate,
  RadioDiscoveryResponse,
  RadioDiscoveryTarget,
  RadioRegionDiscoveryResponse,
  RadioStatsSnapshot,
} from '../../types';

interface RadioConfigDraft {
  name: string;
  lat: string;
  lon: string;
  txPower: string;
  freq: string;
  bw: string;
  sf: string;
  cr: string;
  pathHashMode: string;
  advertLocationSource: 'off' | 'current';
  multiAcksEnabled: boolean;
  repeatEnabled: boolean;
  telemetryModeBase: number;
  telemetryModeLoc: number;
  telemetryModeEnv: number;
  rebootAfterSave: boolean;
  serverError: string;
}

function radioDraftFromConfig(config: RadioConfig): RadioConfigDraft {
  return {
    name: config.name,
    lat: String(config.lat),
    lon: String(config.lon),
    txPower: String(config.tx_power),
    freq: String(config.radio.freq),
    bw: String(config.radio.bw),
    sf: String(config.radio.sf),
    cr: String(config.radio.cr),
    pathHashMode: String(config.path_hash_mode),
    advertLocationSource: config.advert_location_source ?? 'current',
    multiAcksEnabled: config.multi_acks_enabled ?? false,
    repeatEnabled: config.repeat_enabled ?? false,
    telemetryModeBase: config.telemetry_mode_base ?? 0,
    telemetryModeLoc: config.telemetry_mode_loc ?? 0,
    telemetryModeEnv: config.telemetry_mode_env ?? 0,
    rebootAfterSave: false,
    serverError: '',
  };
}

function parseRequiredNumber(value: string, integer = false): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return null;
  return parsed;
}

function buildRadioUpdate(values: RadioConfigDraft, config: RadioConfig): RadioConfigUpdate | null {
  const parsedLat = parseRequiredNumber(values.lat);
  const parsedLon = parseRequiredNumber(values.lon);
  const parsedTxPower = parseRequiredNumber(values.txPower, true);
  const parsedFreq = parseRequiredNumber(values.freq);
  const parsedBw = parseRequiredNumber(values.bw);
  const parsedSf = parseRequiredNumber(values.sf, true);
  const parsedCr = parseRequiredNumber(values.cr, true);
  const parsedPathHashMode = parseRequiredNumber(values.pathHashMode, true);

  if (
    parsedLat === null ||
    parsedLon === null ||
    parsedTxPower === null ||
    parsedFreq === null ||
    parsedBw === null ||
    parsedSf === null ||
    parsedCr === null
  ) {
    return null;
  }

  return {
    name: values.name,
    lat: parsedLat,
    lon: parsedLon,
    tx_power: parsedTxPower,
    ...(values.advertLocationSource !== (config.advert_location_source ?? 'current')
      ? { advert_location_source: values.advertLocationSource }
      : {}),
    ...(values.multiAcksEnabled !== (config.multi_acks_enabled ?? false)
      ? { multi_acks_enabled: values.multiAcksEnabled }
      : {}),
    ...(config.repeat_enabled_supported && values.repeatEnabled !== (config.repeat_enabled ?? false)
      ? { repeat_enabled: values.repeatEnabled }
      : {}),
    ...(values.telemetryModeBase !== (config.telemetry_mode_base ?? 0)
      ? { telemetry_mode_base: values.telemetryModeBase }
      : {}),
    ...(values.telemetryModeLoc !== (config.telemetry_mode_loc ?? 0)
      ? { telemetry_mode_loc: values.telemetryModeLoc }
      : {}),
    ...(values.telemetryModeEnv !== (config.telemetry_mode_env ?? 0)
      ? { telemetry_mode_env: values.telemetryModeEnv }
      : {}),
    radio: { freq: parsedFreq, bw: parsedBw, sf: parsedSf, cr: parsedCr },
    ...(config.path_hash_mode_supported &&
    parsedPathHashMode !== null &&
    parsedPathHashMode !== config.path_hash_mode
      ? { path_hash_mode: parsedPathHashMode }
      : {}),
  };
}

function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatAirtime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function StatRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-xs font-mono tabular-nums ${warn ? 'text-warning font-semibold' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function RadioDetailsCollapsible({ stats }: { stats: RadioStatsSnapshot }) {
  const age = stats.timestamp ? Math.max(0, Math.floor(Date.now() / 1000) - stats.timestamp) : null;
  const packets = {
    recv: stats.packets_recv,
    sent: stats.packets_sent,
    flood_tx: stats.flood_tx,
    direct_tx: stats.direct_tx,
    flood_rx: stats.flood_rx,
    direct_rx: stats.direct_rx,
  };

  return (
    <details className="group">
      <summary className="text-sm font-medium text-foreground cursor-pointer select-none flex items-center gap-1">
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        Radio Details
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-input bg-muted/20 p-3">
        {age !== null && (
          <p className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
            Updated {age < 5 ? 'just now' : `${age}s ago`}
          </p>
        )}

        {/* Core */}
        {stats.uptime_secs != null && (
          <StatRow label="Uptime" value={formatUptime(stats.uptime_secs)} />
        )}
        {stats.battery_mv != null && stats.battery_mv > 0 && (
          <StatRow label="Battery" value={`${(stats.battery_mv / 1000).toFixed(2)}V`} />
        )}
        {stats.queue_len != null && (
          <StatRow
            label="TX Queue"
            value={`${stats.queue_len} / 16`}
            warn={stats.queue_len >= 14}
          />
        )}
        {stats.errors != null && (
          <StatRow label="Errors" value={String(stats.errors)} warn={stats.errors > 0} />
        )}

        {/* RF */}
        {stats.noise_floor != null && (
          <StatRow label="Noise Floor" value={`${stats.noise_floor} dBm`} />
        )}
        {stats.last_rssi != null && <StatRow label="Last RSSI" value={`${stats.last_rssi} dBm`} />}
        {stats.last_snr != null && <StatRow label="Last SNR" value={`${stats.last_snr} dB`} />}

        {/* Airtime */}
        {(stats.tx_air_secs != null || stats.rx_air_secs != null) && (
          <>
            {stats.tx_air_secs != null && (
              <StatRow label="TX Airtime" value={formatAirtime(stats.tx_air_secs)} />
            )}
            {stats.rx_air_secs != null && (
              <StatRow label="RX Airtime" value={formatAirtime(stats.rx_air_secs)} />
            )}
          </>
        )}

        {/* Packets */}
        {packets.recv != null && <StatRow label="Packets Received" value={String(packets.recv)} />}
        {packets.sent != null && <StatRow label="Packets Sent" value={String(packets.sent)} />}
        {packets.flood_tx != null && <StatRow label="Flood TX" value={String(packets.flood_tx)} />}
        {packets.flood_rx != null && <StatRow label="Flood RX" value={String(packets.flood_rx)} />}
        {packets.direct_tx != null && (
          <StatRow label="Direct TX" value={String(packets.direct_tx)} />
        )}
        {packets.direct_rx != null && (
          <StatRow label="Direct RX" value={String(packets.direct_rx)} />
        )}
      </div>
    </details>
  );
}

export function SettingsRadioSection({
  config,
  health,
  appSettings,
  pageMode,
  onSave,
  onSaveAppSettings,
  onSetPrivateKey,
  onReboot,
  onDisconnect,
  onReconnect,
  onAdvertise,
  meshDiscovery,
  meshDiscoveryLoadingTarget,
  onDiscoverMesh,
  regionDiscovery,
  regionDiscoveryLoading,
  onDiscoverRegions,
  onClose,
  className,
}: {
  config: RadioConfig;
  health: HealthStatus | null;
  appSettings: AppSettings;
  pageMode: boolean;
  onSave: (update: RadioConfigUpdate) => Promise<void>;
  onSaveAppSettings: (update: AppSettingsUpdate) => Promise<void>;
  onSetPrivateKey: (key: string) => Promise<void>;
  onReboot: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onAdvertise: (mode: RadioAdvertMode) => Promise<void>;
  meshDiscovery: RadioDiscoveryResponse | null;
  meshDiscoveryLoadingTarget: RadioDiscoveryTarget | null;
  onDiscoverMesh: (target: RadioDiscoveryTarget) => Promise<void>;
  regionDiscovery: RadioRegionDiscoveryResponse | null;
  regionDiscoveryLoading: boolean;
  onDiscoverRegions: (publicKeys?: string[]) => Promise<void>;
  onClose: () => void;
  className?: string;
}) {
  const saveRadioMutation = useMutation({
    mutationFn: (update: RadioConfigUpdate) => onSave(update),
    retry: false,
  });
  const saveAppSettingsMutation = useMutation({
    mutationFn: (update: AppSettingsUpdate) => onSaveAppSettings(update),
    retry: false,
  });
  const setPrivateKeyMutation = useMutation({
    mutationFn: (key: string) => onSetPrivateKey(key),
    retry: false,
  });
  const rebootMutation = useMutation({ mutationFn: () => onReboot(), retry: false });
  const radioForm = useForm({
    defaultValues: radioDraftFromConfig(config),
    onSubmit: async ({ value }) => {
      radioForm.setFieldValue('serverError', '');
      const update = buildRadioUpdate(value, config);
      if (!update) {
        radioForm.setFieldValue(
          'serverError',
          'All numeric fields must contain complete, valid values'
        );
        return;
      }
      try {
        await saveRadioMutation.mutateAsync(update);
        if (value.rebootAfterSave) {
          toast.success('Radio config saved, rebooting...');
          await rebootMutation.mutateAsync();
          if (!pageMode) onClose();
        } else {
          toast.success('Radio config saved');
        }
      } catch (err) {
        radioForm.setFieldValue(
          'serverError',
          err instanceof Error ? err.message : 'Failed to save'
        );
      }
    },
  });
  const radioValues = useStore(radioForm.store, (state) => state.values);
  const radioSubmitting = useStore(radioForm.store, (state) => state.isSubmitting);
  const {
    name,
    lat,
    lon,
    txPower,
    freq,
    bw,
    sf,
    cr,
    pathHashMode,
    advertLocationSource,
    multiAcksEnabled,
    repeatEnabled,
    telemetryModeBase,
    telemetryModeLoc,
    telemetryModeEnv,
    serverError: error,
  } = radioValues;
  const [gettingLocation, setGettingLocation] = useState(false);
  const [officialPresets, setOfficialPresets] = useState<typeof RADIO_PRESETS>([]);
  const [officialPresetsStatus, setOfficialPresetsStatus] = useState(
    'Bundled presets (offline fallback)'
  );
  const allRadioPresets = useMemo(
    () => [
      ...RADIO_PRESETS,
      ...officialPresets.filter((p) => !RADIO_PRESETS.some((b) => b.name === p.name)),
    ],
    [officialPresets]
  );

  useEffect(() => {
    let active = true;
    fetch('/api/radio/presets', { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('presets unavailable');
        return response.json();
      })
      .then((result: { stale: boolean; presets: typeof RADIO_PRESETS }) => {
        if (!active) return;
        if (Array.isArray(result.presets)) {
          setOfficialPresets(result.presets);
          setOfficialPresetsStatus(
            result.stale ? 'Cached suggestions (offline)' : 'Official community suggestions'
          );
        }
      })
      .catch(() => {
        if (active) setOfficialPresetsStatus('Bundled presets (offline fallback)');
      });
    return () => {
      active = false;
    };
  }, []);

  const identityForm = useForm({
    defaultValues: { privateKey: '', serverError: '' },
    onSubmit: async ({ value }) => {
      if (!value.privateKey.trim()) {
        identityForm.setFieldValue('serverError', 'Private key is required');
        return;
      }
      identityForm.setFieldValue('serverError', '');
      try {
        await setPrivateKeyMutation.mutateAsync(value.privateKey.trim());
        identityForm.setFieldValue('privateKey', '');
        toast.success('Private key set, rebooting...');
        await rebootMutation.mutateAsync();
        if (!pageMode) onClose();
      } catch (err) {
        identityForm.setFieldValue(
          'serverError',
          err instanceof Error ? err.message : 'Failed to set private key'
        );
      }
    },
  });
  const identityValues = useStore(identityForm.store, (state) => state.values);
  const identityBusy = useStore(identityForm.store, (state) => state.isSubmitting);
  const privateKey = identityValues.privateKey;
  const identityError = identityValues.serverError;
  const identityRebooting = identityBusy;

  const floodForm = useForm({
    defaultValues: {
      floodScope: stripRegionScopePrefix(appSettings.flood_scope),
      knownRegions: (appSettings.known_regions ?? []).join('\n'),
      maxRadioContacts: String(appSettings.max_radio_contacts),
      serverError: '',
    },
    onSubmit: async ({ value }) => {
      floodForm.setFieldValue('serverError', '');
      const newMaxRadioContacts = parseRequiredNumber(value.maxRadioContacts, true);
      if (newMaxRadioContacts === null || newMaxRadioContacts < 1) {
        floodForm.setFieldValue('serverError', 'Maximum radio contacts must be a positive integer');
        return;
      }
      try {
        const update: AppSettingsUpdate = {};
        if (value.floodScope !== stripRegionScopePrefix(appSettings.flood_scope)) {
          update.flood_scope = value.floodScope;
        }
        const parsedRegions = value.knownRegions
          .split(/[\n,]/)
          .map((region) => region.trim())
          .filter(Boolean);
        if (JSON.stringify(parsedRegions) !== JSON.stringify(appSettings.known_regions ?? [])) {
          update.known_regions = parsedRegions;
        }
        if (newMaxRadioContacts !== appSettings.max_radio_contacts) {
          update.max_radio_contacts = newMaxRadioContacts;
        }
        if (Object.keys(update).length > 0) await saveAppSettingsMutation.mutateAsync(update);
        toast.success('Settings saved');
      } catch (err) {
        floodForm.setFieldValue(
          'serverError',
          err instanceof Error ? err.message : 'Failed to save'
        );
      }
    },
  });
  const floodValues = useStore(floodForm.store, (state) => state.values);
  const floodBusy = useStore(floodForm.store, (state) => state.isSubmitting);
  const { floodScope, knownRegions, maxRadioContacts, serverError: floodError } = floodValues;

  const advertIntervalForm = useForm({
    defaultValues: {
      hours: String(Math.round(appSettings.advert_interval / 3600)),
      serverError: '',
    },
    onSubmit: async ({ value }) => {
      advertIntervalForm.setFieldValue('serverError', '');
      const hours = parseRequiredNumber(value.hours, true);
      if (hours === null || hours < 0) {
        advertIntervalForm.setFieldValue(
          'serverError',
          'Advertising interval must be a whole number of hours, zero or greater'
        );
        return;
      }
      try {
        const newAdvertInterval = hours * 3600;
        if (newAdvertInterval !== appSettings.advert_interval) {
          await saveAppSettingsMutation.mutateAsync({ advert_interval: newAdvertInterval });
        }
        toast.success('Advertising interval saved');
      } catch (err) {
        advertIntervalForm.setFieldValue(
          'serverError',
          err instanceof Error ? err.message : 'Failed to save'
        );
      }
    },
  });
  const advertIntervalValues = useStore(advertIntervalForm.store, (state) => state.values);
  const advertIntervalBusy = useStore(advertIntervalForm.store, (state) => state.isSubmitting);
  const advertIntervalHours = advertIntervalValues.hours;
  const advertIntervalError = advertIntervalValues.serverError;

  const importForm = useForm({
    defaultValues: { data: null as Record<string, unknown> | null },
    onSubmit: async ({ value }) => {
      if (!value.data) return;
      const data = value.data;
      populateFormFromImport(data);
      const update = buildUpdateFromImport(data);
      radioForm.setFieldValue('serverError', '');
      try {
        if (typeof data.private_key === 'string' && data.private_key) {
          await setPrivateKeyMutation.mutateAsync(data.private_key);
          toast.success('Config + private key imported, saving & rebooting...');
        } else {
          toast.success('Config imported, saving & rebooting...');
        }
        await saveRadioMutation.mutateAsync(update);
        await rebootMutation.mutateAsync();
        if (!pageMode) onClose();
      } catch (err) {
        radioForm.setFieldValue(
          'serverError',
          err instanceof Error ? err.message : 'Failed to import config'
        );
      }
    },
  });
  const importBusy = useStore(importForm.store, (state) => state.isSubmitting);
  const busy = radioSubmitting || importBusy;
  const rebooting = importBusy || (radioSubmitting && radioValues.rebootAfterSave);

  // Advertise state
  const [advertisingMode, setAdvertisingMode] = useState<RadioAdvertMode | null>(null);
  const [advertiseResult, setAdvertiseResult] = useState<{
    kind: 'accepted' | 'error';
    message: string;
  } | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);

  const radioFormRef = useRef(radioForm);
  const floodFormRef = useRef(floodForm);
  const advertIntervalFormRef = useRef(advertIntervalForm);
  radioFormRef.current = radioForm;
  floodFormRef.current = floodForm;
  advertIntervalFormRef.current = advertIntervalForm;

  useEffect(() => {
    if (!radioFormRef.current.state.isDirty) {
      radioFormRef.current.reset(radioDraftFromConfig(config));
    }
  }, [config]);

  useEffect(() => {
    if (!floodFormRef.current.state.isDirty) {
      floodFormRef.current.reset({
        floodScope: stripRegionScopePrefix(appSettings.flood_scope),
        knownRegions: (appSettings.known_regions ?? []).join('\n'),
        maxRadioContacts: String(appSettings.max_radio_contacts),
        serverError: '',
      });
    }
    if (!advertIntervalFormRef.current.state.isDirty) {
      advertIntervalFormRef.current.reset({
        hours: String(Math.round(appSettings.advert_interval / 3600)),
        serverError: '',
      });
    }
  }, [appSettings]);

  const currentPreset = useMemo(() => {
    const freqNum = parseFloat(freq);
    const bwNum = parseFloat(bw);
    const sfNum = parseInt(sf, 10);
    const crNum = parseInt(cr, 10);

    for (const preset of allRadioPresets) {
      if (
        preset.freq === freqNum &&
        preset.bw === bwNum &&
        preset.sf === sfNum &&
        preset.cr === crNum
      ) {
        return preset.name;
      }
    }
    return 'custom';
  }, [freq, bw, sf, cr, allRadioPresets]);

  const handlePresetChange = (presetName: string) => {
    if (presetName === 'custom') return;
    const preset = allRadioPresets.find((p) => p.name === presetName);
    if (preset) {
      radioForm.setFieldValue('freq', String(preset.freq));
      radioForm.setFieldValue('bw', String(preset.bw));
      radioForm.setFieldValue('sf', String(preset.sf));
      radioForm.setFieldValue('cr', String(preset.cr));
      // Optional path hash size is only a *draft*, never applied automatically.
      if ('path_hash_size' in preset && typeof preset.path_hash_size === 'number') {
        radioForm.setFieldValue('pathHashMode', String(preset.path_hash_size - 1));
      }
    }
  };

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported', {
        description: 'Your browser does not support geolocation',
      });
      return;
    }

    setGettingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        radioForm.setFieldValue('lat', position.coords.latitude.toFixed(6));
        radioForm.setFieldValue('lon', position.coords.longitude.toFixed(6));
        setGettingLocation(false);
        toast.success('Location updated');
      },
      (err) => {
        setGettingLocation(false);
        toast.error('Failed to get location', {
          description: err.message,
        });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSave = () => {
    radioForm.setFieldValue('rebootAfterSave', false);
    void radioForm.handleSubmit();
  };

  const handleSaveAndReboot = () => {
    radioForm.setFieldValue('rebootAfterSave', true);
    void radioForm.handleSubmit();
  };

  const handleSetPrivateKey = () => void identityForm.handleSubmit();
  const handleSaveFloodSettings = () => void floodForm.handleSubmit();
  const handleSaveAdvertInterval = () => void advertIntervalForm.handleSubmit();

  const handleAdvertise = async (mode: RadioAdvertMode) => {
    if (advertisingMode !== null) return;
    setAdvertiseResult(null);
    setAdvertisingMode(mode);
    try {
      await onAdvertise(mode);
      setAdvertiseResult({
        kind: 'accepted',
        message: `${mode === 'zero_hop' ? 'Zero-hop' : 'Flood'} advertisement accepted by the radio. Peer receipt is not confirmed.`,
      });
    } catch (error) {
      setAdvertiseResult({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'The advertisement request was not accepted',
      });
    } finally {
      setAdvertisingMode(null);
    }
  };

  const handleDiscover = async (target: RadioDiscoveryTarget) => {
    setDiscoverError(null);
    try {
      await onDiscoverMesh(target);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : 'Failed to run mesh discovery');
    }
  };

  const handleDiscoverRegions = async () => {
    // Prefer repeaters from the most recent mesh-discovery sweep (they just
    // answered, so they're likely in range for the direct-routed regions
    // request); otherwise let the backend pick recent repeater contacts.
    const discoveredRepeaterKeys = (meshDiscovery?.results ?? [])
      .filter((r) => r.node_type === 'repeater')
      .map((r) => r.public_key);
    await onDiscoverRegions(discoveredRepeaterKeys);
  };

  const handleAddDiscoveredRegions = () => {
    if (!regionDiscovery || regionDiscovery.regions.length === 0) return;
    const existing = knownRegions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    const additions = regionDiscovery.regions.filter((r) => !seen.has(r.toLowerCase()));
    if (additions.length === 0) {
      toast.info('All discovered regions are already listed');
      return;
    }
    floodForm.setFieldValue('knownRegions', [...existing, ...additions].join('\n'));
    toast.success(
      `Added ${additions.length} region${additions.length === 1 ? '' : 's'} — review and Save Messaging Settings`
    );
  };

  const importInputRef = useRef<HTMLInputElement>(null);
  const [keyImportDialogOpen, setKeyImportDialogOpen] = useState(false);
  const pendingImportRef = useRef<Record<string, unknown> | null>(null);

  const buildConfigProfile = () => ({
    version: 1,
    exported_at: new Date().toISOString(),
    name: config.name,
    lat: config.lat,
    lon: config.lon,
    tx_power: config.tx_power,
    radio: { ...config.radio },
    path_hash_mode: config.path_hash_mode,
    advert_location_source: config.advert_location_source ?? 'current',
    multi_acks_enabled: config.multi_acks_enabled ?? false,
    ...(config.repeat_enabled_supported ? { repeat_enabled: config.repeat_enabled ?? false } : {}),
    telemetry_mode_base: config.telemetry_mode_base ?? 0,
    telemetry_mode_loc: config.telemetry_mode_loc ?? 0,
    telemetry_mode_env: config.telemetry_mode_env ?? 0,
  });

  const downloadJson = (profile: object, suffix: string) => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (config.name || 'radio').replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date()
      .toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(/[/:, ]+/g, '-');
    a.download = `${safeName}-${suffix}-${timestamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportConfig = async () => {
    const profile = buildConfigProfile();
    try {
      const { private_key } = await api.getPrivateKey();
      downloadJson({ ...profile, private_key }, 'config');
      toast.success('Export generated with private key');
    } catch {
      downloadJson(profile, 'config');
      toast.info('Export generated without private key', {
        description: 'See README_ADVANCED.md for private key export enable',
      });
    }
  };

  const validateImportData = (
    data: unknown
  ): data is {
    name: string;
    radio: { freq: number; bw: number; sf: number; cr: number };
    [k: string]: unknown;
  } =>
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    typeof (data as Record<string, unknown>).name === 'string' &&
    'radio' in data &&
    typeof (data as Record<string, unknown>).radio === 'object' &&
    (data as Record<string, unknown>).radio !== null &&
    typeof (data as Record<string, Record<string, unknown>>).radio.freq === 'number' &&
    typeof (data as Record<string, Record<string, unknown>>).radio.bw === 'number' &&
    typeof (data as Record<string, Record<string, unknown>>).radio.sf === 'number' &&
    typeof (data as Record<string, Record<string, unknown>>).radio.cr === 'number';

  const populateFormFromImport = (data: Record<string, unknown>) => {
    const radio = data.radio as { freq: number; bw: number; sf: number; cr: number };
    radioForm.setFieldValue('name', data.name as string);
    if (typeof data.lat === 'number') radioForm.setFieldValue('lat', String(data.lat));
    if (typeof data.lon === 'number') radioForm.setFieldValue('lon', String(data.lon));
    if (typeof data.tx_power === 'number')
      radioForm.setFieldValue('txPower', String(data.tx_power));
    radioForm.setFieldValue('freq', String(radio.freq));
    radioForm.setFieldValue('bw', String(radio.bw));
    radioForm.setFieldValue('sf', String(radio.sf));
    radioForm.setFieldValue('cr', String(radio.cr));
    if (typeof data.path_hash_mode === 'number')
      radioForm.setFieldValue('pathHashMode', String(data.path_hash_mode));
    if (data.advert_location_source === 'off' || data.advert_location_source === 'current')
      radioForm.setFieldValue('advertLocationSource', data.advert_location_source);
    if (typeof data.multi_acks_enabled === 'boolean')
      radioForm.setFieldValue('multiAcksEnabled', data.multi_acks_enabled);
    if (config.repeat_enabled_supported && typeof data.repeat_enabled === 'boolean')
      radioForm.setFieldValue('repeatEnabled', data.repeat_enabled);
    if (typeof data.telemetry_mode_base === 'number')
      radioForm.setFieldValue('telemetryModeBase', data.telemetry_mode_base);
    if (typeof data.telemetry_mode_loc === 'number')
      radioForm.setFieldValue('telemetryModeLoc', data.telemetry_mode_loc);
    if (typeof data.telemetry_mode_env === 'number')
      radioForm.setFieldValue('telemetryModeEnv', data.telemetry_mode_env);
  };

  const buildUpdateFromImport = (data: Record<string, unknown>): RadioConfigUpdate => {
    const radio = data.radio as { freq: number; bw: number; sf: number; cr: number };
    const update: RadioConfigUpdate = {
      name: data.name as string,
      lat: typeof data.lat === 'number' ? data.lat : config.lat,
      lon: typeof data.lon === 'number' ? data.lon : config.lon,
      tx_power: typeof data.tx_power === 'number' ? (data.tx_power as number) : config.tx_power,
      radio,
    };
    if (data.advert_location_source === 'off' || data.advert_location_source === 'current')
      update.advert_location_source = data.advert_location_source;
    if (typeof data.multi_acks_enabled === 'boolean')
      update.multi_acks_enabled = data.multi_acks_enabled;
    if (config.repeat_enabled_supported && typeof data.repeat_enabled === 'boolean')
      update.repeat_enabled = data.repeat_enabled;
    if (typeof data.telemetry_mode_base === 'number')
      update.telemetry_mode_base = data.telemetry_mode_base as number;
    if (typeof data.telemetry_mode_loc === 'number')
      update.telemetry_mode_loc = data.telemetry_mode_loc as number;
    if (typeof data.telemetry_mode_env === 'number')
      update.telemetry_mode_env = data.telemetry_mode_env as number;
    if (config.path_hash_mode_supported && typeof data.path_hash_mode === 'number')
      update.path_hash_mode = data.path_hash_mode as number;
    return update;
  };

  const applyImport = async (data: Record<string, unknown>) => {
    importForm.setFieldValue('data', data);
    await importForm.handleSubmit();
  };

  const handleImportConfig = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!validateImportData(data)) {
        toast.error('Invalid config file', {
          description: 'File must contain name and radio parameters (freq, bw, sf, cr)',
        });
        return;
      }

      if (typeof data.private_key === 'string' && data.private_key) {
        // Private key present — show warning dialog before applying
        pendingImportRef.current = data;
        setKeyImportDialogOpen(true);
      } else {
        await applyImport(data);
      }
    } catch (err) {
      radioForm.setFieldValue(
        'serverError',
        err instanceof Error ? err.message : 'Failed to import config'
      );
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const handleConfirmKeyImport = async () => {
    setKeyImportDialogOpen(false);
    const data = pendingImportRef.current;
    pendingImportRef.current = null;
    if (data) await applyImport(data);
  };

  const radioState =
    health?.radio_state ??
    (health?.radio_initializing
      ? 'initializing'
      : health?.radio_connected
        ? 'connected'
        : 'disconnected');
  const transportConnected = health?.radio_connected === true;
  const radioReady = transportConnected && (radioState === 'ready' || radioState === 'connected');
  const radioDegraded = transportConnected && radioState === 'degraded';
  const radioSetupFailed = transportConnected && radioState === 'failed';
  const connectionActionLabel =
    radioState === 'paused' ? 'Reconnect' : transportConnected ? 'Disconnect' : 'Stop Trying';

  const connectionStatusLabel = radioReady
    ? health?.connection_info || 'Connected'
    : radioDegraded
      ? `Connected (degraded${health?.startup_error_stage ? ` at ${health.startup_error_stage}` : ''})`
      : radioSetupFailed
        ? `Connected — setup failed${health?.startup_error_stage ? ` at ${health.startup_error_stage}` : ''}`
        : radioState === 'initializing'
          ? `Initializing ${health?.connection_info || 'radio'}`
          : radioState === 'connecting'
            ? `Attempting to connect${health?.connection_info ? ` to ${health.connection_info}` : ''}`
            : radioState === 'paused'
              ? `Connection paused${health?.connection_info ? ` (${health.connection_info})` : ''}`
              : 'Not connected';

  const deviceInfoLabel = useMemo(() => {
    const info = health?.radio_device_info;
    if (!info) {
      return null;
    }

    const model = info.model?.trim() || null;
    const firmwareParts = [info.firmware_build?.trim(), info.firmware_version?.trim()].filter(
      (value): value is string => Boolean(value)
    );
    const capacityParts = [
      typeof info.max_contacts === 'number' ? `${info.max_contacts} contacts` : null,
      typeof info.max_channels === 'number' ? `${info.max_channels} channels` : null,
    ].filter((value): value is string => value !== null);

    if (!model && firmwareParts.length === 0 && capacityParts.length === 0) {
      return null;
    }

    let label = model ?? 'Radio';
    if (firmwareParts.length > 0) {
      label += ` running ${firmwareParts.join('/')}`;
    }
    if (capacityParts.length > 0) {
      label += ` (max: ${capacityParts.join(', ')})`;
    }
    return label;
  }, [health?.radio_device_info]);

  const handleConnectionAction = async () => {
    setConnectionBusy(true);
    try {
      if (radioState === 'paused') {
        await onReconnect();
        toast.success('Reconnect requested');
      } else {
        await onDisconnect();
        toast.success('Radio connection paused');
      }
    } catch (err) {
      toast.error('Failed to change radio connection state', {
        description: err instanceof Error ? err.message : 'Check radio connection and try again',
      });
    } finally {
      setConnectionBusy(false);
    }
  };

  return (
    <div className={className}>
      {/* ── Connection ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">Connection</h3>
        <div className="flex items-center gap-2" role="status" aria-label={connectionStatusLabel}>
          <div
            className={`w-2 h-2 rounded-full ${
              radioReady
                ? 'bg-status-connected'
                : radioDegraded || radioState === 'initializing' || radioState === 'connecting'
                  ? 'bg-warning'
                  : 'bg-status-disconnected'
            }`}
          />
          <span
            className={
              radioState === 'paused' || radioState === 'disconnected'
                ? 'text-muted-foreground'
                : ''
            }
          >
            {connectionStatusLabel}
          </span>
        </div>
        {deviceInfoLabel && <p className="text-sm text-muted-foreground">{deviceInfoLabel}</p>}

        {health?.radio_stats && <RadioDetailsCollapsible stats={health.radio_stats} />}

        <Button
          type="button"
          variant="outline"
          onClick={handleConnectionAction}
          disabled={connectionBusy}
          className="w-full"
        >
          {connectionBusy ? `${connectionActionLabel}...` : connectionActionLabel}
        </Button>
        <p className="text-[0.8125rem] text-muted-foreground">
          Disconnect pauses automatic reconnect attempts so another device can use the radio.
        </p>
      </div>

      <Separator />

      {/* ── Identity ── */}
      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">Identity</h3>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Radio Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => radioForm.setFieldValue('name', e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="public-key">Public Key</Label>
        <Input id="public-key" value={config.public_key} disabled className="font-mono text-xs" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="private-key">Set Private Key (write-only)</Label>
        <Input
          id="private-key"
          type="password"
          autoComplete="off"
          value={privateKey}
          onChange={(e) => identityForm.setFieldValue('privateKey', e.target.value)}
          placeholder="64-character hex private key"
          aria-invalid={identityError ? true : undefined}
          aria-describedby={identityError ? 'private-key-error' : undefined}
        />
        <Button
          onClick={handleSetPrivateKey}
          disabled={identityBusy || identityRebooting || !privateKey.trim()}
          className="w-full border-destructive/50 text-destructive hover:bg-destructive/10"
          variant="outline"
        >
          {identityBusy || identityRebooting
            ? 'Setting & Rebooting...'
            : 'Set Private Key & Reboot'}
        </Button>
      </div>

      {identityError && (
        <div id="private-key-error" className="text-sm text-destructive" role="alert">
          {identityError}
        </div>
      )}

      <Separator />

      {/* ── Radio Parameters ── */}
      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">Radio Parameters</h3>
      </div>

      <div className="space-y-2">
        <Label htmlFor="preset">Preset</Label>
        <select
          id="preset"
          value={currentPreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <option value="custom">Custom</option>
          {allRadioPresets.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {officialPresetsStatus}. Suggestions do not change the radio until saved. Verify local
          radio regulations.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="freq">Frequency (MHz)</Label>
          <Input
            id="freq"
            type="number"
            step="any"
            value={freq}
            onChange={(e) => radioForm.setFieldValue('freq', e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'radio-config-error' : undefined}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bw">Bandwidth (kHz)</Label>
          <Input
            id="bw"
            type="number"
            step="any"
            value={bw}
            onChange={(e) => radioForm.setFieldValue('bw', e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'radio-config-error' : undefined}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="sf">Spreading Factor</Label>
          <Input
            id="sf"
            type="number"
            min="7"
            max="12"
            value={sf}
            onChange={(e) => radioForm.setFieldValue('sf', e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'radio-config-error' : undefined}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cr">Coding Rate</Label>
          <Input
            id="cr"
            type="number"
            min="5"
            max="8"
            value={cr}
            onChange={(e) => radioForm.setFieldValue('cr', e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'radio-config-error' : undefined}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="tx-power">TX Power (dBm)</Label>
          <Input
            id="tx-power"
            type="number"
            value={txPower}
            onChange={(e) => radioForm.setFieldValue('txPower', e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'radio-config-error' : undefined}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="max-tx">Max TX Power</Label>
          <Input id="max-tx" type="number" value={config.max_tx_power} disabled />
        </div>
      </div>

      {config.repeat_enabled_supported && (
        <div className="flex items-start gap-3 rounded-md border border-input p-3">
          <Checkbox
            id="repeat-enabled"
            checked={repeatEnabled}
            onCheckedChange={(checked) =>
              radioForm.setFieldValue('repeatEnabled', checked === true)
            }
          />
          <div className="space-y-1">
            <Label htmlFor="repeat-enabled">Companion Repeat Mode</Label>
            <p className="text-[0.8125rem] text-muted-foreground">
              Repeat eligible mesh traffic through this companion radio. Firmware may reject this
              setting on unsupported frequencies.
            </p>
          </div>
        </div>
      )}

      {config.path_hash_mode_supported && (
        <div className="space-y-2">
          <Label htmlFor="path-hash-mode">Path Hash Mode</Label>
          <select
            id="path-hash-mode"
            value={pathHashMode}
            onChange={(e) => radioForm.setFieldValue('pathHashMode', e.target.value)}
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <option value="0">1 byte — up to 63 hops (default)</option>
            <option value="1">2 bytes — up to 32 hops</option>
            <option value="2">3 bytes — up to 21 hops</option>
          </select>
          <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-xs text-warning">
            <p className="font-semibold mb-1">Compatibility Warning</p>
            <p>
              ALL nodes along a message&apos;s route &mdash; your radio, every repeater, and the
              recipient &mdash; must be running firmware that supports the selected mode. Messages
              sent with 2-byte or 3-byte hops will be dropped by any node on older firmware.
            </p>
          </div>
        </div>
      )}

      <Separator />

      {/* ── Location ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold tracking-tight">Location</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleGetLocation}
            disabled={gettingLocation}
          >
            {gettingLocation ? (
              'Getting...'
            ) : (
              <>
                <MapPinned className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Use My Location
              </>
            )}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="lat" className="text-xs text-muted-foreground">
              Latitude
            </Label>
            <Input
              id="lat"
              type="number"
              step="any"
              value={lat}
              onChange={(e) => radioForm.setFieldValue('lat', e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'radio-config-error' : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lon" className="text-xs text-muted-foreground">
              Longitude
            </Label>
            <Input
              id="lon"
              type="number"
              step="any"
              value={lon}
              onChange={(e) => radioForm.setFieldValue('lon', e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'radio-config-error' : undefined}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="advert-location-source">Advert Location Source</Label>
          <select
            id="advert-location-source"
            value={advertLocationSource}
            onChange={(e) =>
              radioForm.setFieldValue('advertLocationSource', e.target.value as 'off' | 'current')
            }
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <option value="off">Off</option>
            <option value="current">Include Node Location</option>
          </select>
          <p className="text-[0.8125rem] text-muted-foreground">
            Companion-radio firmware does not distinguish between saved coordinates and live GPS
            here. When enabled, adverts include the node&apos;s current location state. That may be
            the last coordinates you set from MESHRIK or live GPS coordinates if the node itself is
            already updating them. MESHRIK cannot enable GPS on the node through the interface
            library.
          </p>
        </div>
      </div>

      <Separator />

      {/* ── Telemetry Sharing ── */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">Telemetry Sharing</h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          Controls what this radio shares when other nodes request its telemetry. &ldquo;Deny&rdquo;
          blocks all requests, &ldquo;Per-Contact&rdquo; uses per-contact permission flags on the
          radio, and &ldquo;Allow All&rdquo; shares with any requester.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="telemetry-mode-base" className="text-sm">
              Battery &amp; Base
            </Label>
            <select
              id="telemetry-mode-base"
              value={telemetryModeBase}
              onChange={(e) => radioForm.setFieldValue('telemetryModeBase', Number(e.target.value))}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value={0}>Deny</option>
              <option value={1}>Per-Contact</option>
              <option value={2}>Allow All</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="telemetry-mode-loc" className="text-sm">
              Location
            </Label>
            <select
              id="telemetry-mode-loc"
              value={telemetryModeLoc}
              onChange={(e) => radioForm.setFieldValue('telemetryModeLoc', Number(e.target.value))}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value={0}>Deny</option>
              <option value={1}>Per-Contact</option>
              <option value={2}>Allow All</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="telemetry-mode-env" className="text-sm">
              Environment Sensors
            </Label>
            <select
              id="telemetry-mode-env"
              value={telemetryModeEnv}
              onChange={(e) => radioForm.setFieldValue('telemetryModeEnv', Number(e.target.value))}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value={0}>Deny</option>
              <option value={1}>Per-Contact</option>
              <option value={2}>Allow All</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div id="radio-config-error" className="text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          disabled={busy || rebooting}
          variant="outline"
          className="flex-1"
        >
          {busy && !rebooting ? 'Saving...' : 'Save Radio Config'}
        </Button>
        <Button onClick={handleSaveAndReboot} disabled={busy || rebooting} className="flex-1">
          {rebooting ? 'Rebooting...' : 'Save Radio Config & Reboot'}
        </Button>
      </div>
      <p className="text-[0.8125rem] text-muted-foreground">
        Some settings may require a reboot to take effect on some radios.
      </p>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleExportConfig} className="flex-1">
          <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Export Config
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => importInputRef.current?.click()}
          disabled={busy || rebooting}
          className="flex-1"
        >
          <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Import &amp; Reboot
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportConfig(file);
          }}
        />
      </div>
      <p className="text-[0.8125rem] text-muted-foreground">
        Export saves the current server config to a JSON file. Import loads a config file, applies
        it, and reboots the radio.
      </p>

      <Separator />

      {/* ── Messaging ── */}
      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">Messaging</h3>
      </div>

      <div className="space-y-2">
        <div className="flex items-start gap-3 rounded-md border border-border/60 p-3">
          <Checkbox
            id="multi-acks-enabled"
            checked={multiAcksEnabled}
            onCheckedChange={(checked) =>
              radioForm.setFieldValue('multiAcksEnabled', checked === true)
            }
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor="multi-acks-enabled">Extra Direct ACK Transmission</Label>
            <p className="text-[0.8125rem] text-muted-foreground">
              When enabled, the radio sends one extra direct ACK transmission before the normal ACK
              for received direct messages. This is a firmware-level receive behavior, not a MESHRIK
              retry setting.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-md border border-border/60 p-3">
          <Checkbox
            id="auto-resend-channel"
            checked={appSettings.auto_resend_channel}
            onCheckedChange={(checked) =>
              onSaveAppSettings({ auto_resend_channel: checked === true })
            }
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor="auto-resend-channel">Auto-Resend Unheard Channel Messages</Label>
            <p className="text-[0.8125rem] text-muted-foreground">
              When enabled, outgoing channel messages that receive no echo within 2 seconds are
              automatically resent once (byte-perfect, within the 30-second dedup window). Repeaters
              that already heard the original will ignore the duplicate. This functionality will NOT
              create double-sent/duplicate messages.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="flood-scope">Flood Scope / Region</Label>
        <Input
          id="flood-scope"
          value={floodScope}
          onChange={(e) => floodForm.setFieldValue('floodScope', e.target.value)}
          placeholder="MyRegion"
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          Tag outgoing messages with a region name (e.g. MyRegion). Repeaters configured for that
          region can forward the traffic, while repeaters configured to deny other regions may drop
          it. Leave empty to send unscoped (plain flood). Forcing unscoped when a default scope is
          configured on the radio requires firmware v12 or newer. Individual channels can override
          this with their own region or an "always unscoped" setting.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="known-regions">Known Regions (for decoding)</Label>
        <textarea
          id="known-regions"
          value={knownRegions}
          onChange={(e) => floodForm.setFieldValue('knownRegions', e.target.value)}
          rows={4}
          placeholder={'nl-gr\nde-by\nMyRegion'}
          spellCheck={false}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          One region name per line. Incoming region-scoped (TransportFlood/TransportDirect) packets
          are matched against this list so messages and the packet inspector show a readable region
          label instead of a raw transport code. Saving a change re-tags existing messages whose
          original packet is still stored.
        </p>

        <div className="space-y-2 rounded-md border border-input bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
              Discover regions from repeaters
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDiscoverRegions}
              disabled={regionDiscoveryLoading || !health?.radio_connected}
            >
              {regionDiscoveryLoading ? 'Asking repeaters...' : 'Discover Regions'}
            </Button>
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            Asks nearby repeaters which regions they flood, so you can populate the list above. Uses
            repeaters from your last mesh discovery sweep when available, otherwise your most
            recently seen repeaters. Only repeaters in direct range answer, and this only reveals
            flood-allowed regions (not blocked ones).
          </p>
          {!health?.radio_connected && (
            <p className="text-sm text-destructive">Radio not connected</p>
          )}
          {regionDiscovery && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {regionDiscovery.repeaters_answered}/{regionDiscovery.repeaters_queried} repeater
                {regionDiscovery.repeaters_queried === 1 ? '' : 's'} answered
                {regionDiscovery.regions.length > 0
                  ? ` — ${regionDiscovery.regions.length} region${regionDiscovery.regions.length === 1 ? '' : 's'} found`
                  : ''}
              </p>
              {regionDiscovery.regions.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {regionDiscovery.regions.map((region) => (
                      <span
                        key={region}
                        className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 font-mono"
                      >
                        {region}
                      </span>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddDiscoveredRegions}
                    className="border-success/50 text-success hover:bg-success/10"
                  >
                    Add to Known Regions
                  </Button>
                </>
              ) : (
                regionDiscovery.repeaters_queried > 0 && (
                  <p className="text-sm text-muted-foreground">
                    No flood-allowed regions were reported.
                  </p>
                )
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="max-contacts">Max Contacts on Radio</Label>
        <Input
          id="max-contacts"
          type="number"
          min="1"
          max="1000"
          value={maxRadioContacts}
          onChange={(e) => floodForm.setFieldValue('maxRadioContacts', e.target.value)}
          aria-invalid={floodError ? true : undefined}
          aria-describedby={floodError ? 'max-contacts-error' : undefined}
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          Configured radio contact capacity. Favorites reload first, then background maintenance
          refills to about 80% of this value and offloads once occupancy reaches about 95%.
        </p>
        {health?.radio_device_info?.max_contacts != null &&
          Number(maxRadioContacts) > health.radio_device_info.max_contacts && (
            <p className="text-xs text-warning">
              Your radio reports a hardware limit of {health.radio_device_info.max_contacts}{' '}
              contacts. The effective cap will be limited to what the radio supports.
            </p>
          )}
      </div>

      {floodError && (
        <div id="max-contacts-error" className="text-sm text-destructive" role="alert">
          {floodError}
        </div>
      )}

      <Button onClick={handleSaveFloodSettings} disabled={floodBusy} className="w-full">
        {floodBusy ? 'Saving...' : 'Save Messaging Settings'}
      </Button>

      <Separator />

      {/* ── Advertising & Discovery ── */}
      <div className="space-y-5">
        <h3 className="text-base font-semibold tracking-tight">Advertising &amp; Discovery</h3>

        <div className="space-y-2">
          <Label htmlFor="advert-interval">Periodic Advertising Interval</Label>
          <div className="flex items-center gap-2">
            <Input
              id="advert-interval"
              type="number"
              min="0"
              value={advertIntervalHours}
              onChange={(e) => advertIntervalForm.setFieldValue('hours', e.target.value)}
              className="w-28"
              aria-invalid={advertIntervalError ? true : undefined}
              aria-describedby={advertIntervalError ? 'advert-interval-error' : undefined}
            />
            <span className="text-sm text-muted-foreground">hours (0 = off)</span>
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            How often to automatically advertise presence. Set to 0 to disable. Minimum: 1 hour.
            Recommended: 24 hours or higher.
          </p>
          {advertIntervalError && (
            <div id="advert-interval-error" className="text-sm text-destructive" role="alert">
              {advertIntervalError}
            </div>
          )}
          <Button
            onClick={handleSaveAdvertInterval}
            disabled={advertIntervalBusy}
            className="w-full"
          >
            {advertIntervalBusy ? 'Saving...' : 'Save Advertising Interval'}
          </Button>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Send Advertisement</h4>
          <p className="text-[0.8125rem] text-muted-foreground">
            Flood adverts propagate through repeaters. Zero-hop adverts are local-only and use less
            airtime.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              onClick={() => handleAdvertise('flood')}
              disabled={advertisingMode !== null || !health?.radio_connected}
              className="w-full bg-warning hover:bg-warning/90 text-warning-foreground"
            >
              {advertisingMode === 'flood' ? 'Sending...' : 'Send Flood Advertisement'}
            </Button>
            <Button
              onClick={() => handleAdvertise('zero_hop')}
              disabled={advertisingMode !== null || !health?.radio_connected}
              className="w-full"
            >
              {advertisingMode === 'zero_hop' ? 'Sending...' : 'Send Zero-Hop Advertisement'}
            </Button>
          </div>
          {!health?.radio_connected && (
            <p className="text-sm text-destructive">Radio not connected</p>
          )}
          {advertiseResult && (
            <p
              className={
                advertiseResult.kind === 'error'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
              role={advertiseResult.kind === 'error' ? 'alert' : 'status'}
            >
              {advertiseResult.message}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Mesh Discovery</h4>
          <p className="text-[0.8125rem] text-muted-foreground">
            Discover nearby node types that currently respond to mesh discovery requests: repeaters
            and sensors.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { target: 'repeaters', label: 'Discover Repeaters' },
              { target: 'sensors', label: 'Discover Sensors' },
              { target: 'all', label: 'Discover Both' },
            ].map(({ target, label }) => (
              <Button
                key={target}
                type="button"
                variant="outline"
                onClick={() => handleDiscover(target as RadioDiscoveryTarget)}
                disabled={meshDiscoveryLoadingTarget !== null || !health?.radio_connected}
                className="w-full"
              >
                {meshDiscoveryLoadingTarget === target ? 'Listening...' : label}
              </Button>
            ))}
          </div>
          {!health?.radio_connected && (
            <p className="text-sm text-destructive">Radio not connected</p>
          )}
          {discoverError && (
            <p className="text-sm text-destructive" role="alert">
              {discoverError}
            </p>
          )}
          {meshDiscovery && (
            <div className="space-y-2 rounded-md border border-input bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">
                  Last sweep: {meshDiscovery.results.length} node
                  {meshDiscovery.results.length === 1 ? '' : 's'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {meshDiscovery.duration_seconds.toFixed(0)}s listen window
                </p>
              </div>
              {meshDiscovery.results.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No supported nodes responded during the last discovery sweep.
                </p>
              ) : (
                <div className="space-y-2">
                  {meshDiscovery.results.map((result) => (
                    <div
                      key={result.public_key}
                      className="rounded-md border border-input bg-background px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">
                          {result.name ?? <span className="capitalize">{result.node_type}</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          heard {result.heard_count} time{result.heard_count === 1 ? '' : 's'}
                        </span>
                      </div>
                      {result.name && (
                        <p className="text-xs capitalize text-muted-foreground">
                          {result.node_type}
                        </p>
                      )}
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {result.public_key}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Heard here: {result.local_snr ?? 'n/a'} dB SNR /{' '}
                        {result.local_rssi ?? 'n/a'} dBm RSSI. Remote heard us:{' '}
                        {result.remote_snr ?? 'n/a'} dB SNR.
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Private Key Import Warning ── */}
      <Dialog
        open={keyImportDialogOpen}
        onOpenChange={(open) => {
          setKeyImportDialogOpen(open);
          if (!open) pendingImportRef.current = null;
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import includes Private Key</DialogTitle>
            <DialogDescription>
              This config file contains a private key. Importing it will change your radio&apos;s
              identity &mdash; your radio will have a new public key and other nodes will see it as
              a different device. This cannot be undone without the original key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setKeyImportDialogOpen(false);
                pendingImportRef.current = null;
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmKeyImport}
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              variant="outline"
            >
              Import Config &amp; Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
