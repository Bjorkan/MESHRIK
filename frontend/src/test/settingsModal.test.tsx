import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsModal } from '../components/SettingsModal';
import type {
  AppSettings,
  AppSettingsUpdate,
  Contact,
  HealthStatus,
  RadioAdvertMode,
  RadioConfig,
  RadioConfigUpdate,
  RadioDiscoveryResponse,
  RadioDiscoveryTarget,
  RadioRegionDiscoveryResponse,
  StatisticsResponse,
} from '../types';
import type { SettingsSection } from '../components/settings/settingsConstants';
import {
  LAST_VIEWED_CONVERSATION_KEY,
  REOPEN_LAST_CONVERSATION_KEY,
} from '../utils/lastViewedConversation';
import { api } from '../api';
import { DISTANCE_UNIT_KEY } from '../utils/distanceUnits';
import { SHOW_PATH_HOP_WIDTH_KEY } from '../utils/pathHopWidthPreference';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_KEY,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
} from '../utils/fontScale';

const baseConfig: RadioConfig = {
  public_key: 'aa'.repeat(32),
  name: 'TestNode',
  lat: 1,
  lon: 2,
  tx_power: 17,
  max_tx_power: 22,
  radio: {
    freq: 910.525,
    bw: 62.5,
    sf: 7,
    cr: 5,
  },
  path_hash_mode: 0,
  path_hash_mode_supported: false,
  advert_location_source: 'current',
  multi_acks_enabled: false,
  repeat_enabled: null,
  repeat_enabled_supported: false,
};

const baseHealth: HealthStatus = {
  status: 'connected',
  radio_connected: true,
  radio_initializing: false,
  connection_info: 'Serial: /dev/ttyUSB0',
  database_size_mb: 1.2,
  oldest_undecrypted_timestamp: null,
  fanout_statuses: {},
  bots_disabled: false,
};

const baseSettings: AppSettings = {
  max_radio_contacts: 200,
  auto_decrypt_dm_on_advert: false,
  last_message_times: {},

  advert_interval: 0,
  last_advert_time: 0,
  flood_scope: '',
  known_regions: [],
  blocked_keys: [],
  blocked_names: [],
  discovery_blocked_types: [],
  tracked_telemetry_repeaters: [],
  tracked_telemetry_contacts: [],
  auto_resend_channel: false,
  telemetry_interval_hours: 8,
  telemetry_routed_hourly: false,
};

function renderModal(overrides?: {
  config?: RadioConfig | null;
  appSettings?: AppSettings;
  health?: HealthStatus;
  onSaveAppSettings?: (update: AppSettingsUpdate) => Promise<void>;
  onRefreshAppSettings?: () => Promise<void>;
  onSave?: (update: RadioConfigUpdate) => Promise<void>;
  onClose?: () => void;
  onSetPrivateKey?: (key: string) => Promise<void>;
  onReboot?: () => Promise<void>;
  onDisconnect?: () => Promise<void>;
  onReconnect?: () => Promise<void>;
  onAdvertise?: (mode: RadioAdvertMode) => Promise<void>;
  meshDiscovery?: RadioDiscoveryResponse | null;
  meshDiscoveryLoadingTarget?: RadioDiscoveryTarget | null;
  onDiscoverMesh?: (target: RadioDiscoveryTarget) => Promise<void>;
  regionDiscovery?: RadioRegionDiscoveryResponse | null;
  contacts?: Contact[];
  trackedTelemetryRepeaters?: string[];
  open?: boolean;
  pageMode?: boolean;
  externalSidebarNav?: boolean;
  desktopSection?: SettingsSection;
  mobile?: boolean;
}) {
  const setMobile = setMatchMedia(overrides?.mobile ?? false);

  const onSaveAppSettings = overrides?.onSaveAppSettings ?? vi.fn(async () => {});
  const onRefreshAppSettings = overrides?.onRefreshAppSettings ?? vi.fn(async () => {});
  const onSave = overrides?.onSave ?? vi.fn(async (_update: RadioConfigUpdate) => {});
  const onClose = overrides?.onClose ?? vi.fn();
  const onSetPrivateKey = overrides?.onSetPrivateKey ?? vi.fn(async () => {});
  const onReboot = overrides?.onReboot ?? vi.fn(async () => {});
  const onDisconnect = overrides?.onDisconnect ?? vi.fn(async () => {});
  const onReconnect = overrides?.onReconnect ?? vi.fn(async () => {});
  const onAdvertise = overrides?.onAdvertise ?? vi.fn(async (_mode: RadioAdvertMode) => {});
  const onDiscoverMesh = overrides?.onDiscoverMesh ?? vi.fn(async () => {});
  const onDiscoverRegions = vi.fn(async () => {});

  const commonProps = {
    open: overrides?.open ?? true,
    pageMode: overrides?.pageMode,
    config: overrides?.config === undefined ? baseConfig : overrides.config,
    health: overrides?.health ?? baseHealth,
    appSettings: overrides?.appSettings ?? baseSettings,
    onClose,
    onSave,
    onSaveAppSettings,
    onSetPrivateKey,
    onReboot,
    onDisconnect,
    onReconnect,
    onAdvertise,
    meshDiscovery: overrides?.meshDiscovery ?? null,
    meshDiscoveryLoadingTarget: overrides?.meshDiscoveryLoadingTarget ?? null,
    onDiscoverMesh,
    regionDiscovery: overrides?.regionDiscovery ?? null,
    regionDiscoveryLoading: false,
    onDiscoverRegions,
    onHealthRefresh: vi.fn(async () => {}),
    onRefreshAppSettings,
    contacts: overrides?.contacts,
    trackedTelemetryRepeaters: overrides?.trackedTelemetryRepeaters,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const renderSettings = (
    desktopSection: SettingsSection = overrides?.desktopSection ?? 'radio'
  ) => (
    <QueryClientProvider client={queryClient}>
      {overrides?.externalSidebarNav ? (
        <SettingsModal {...commonProps} externalSidebarNav desktopSection={desktopSection} />
      ) : (
        <SettingsModal {...commonProps} />
      )}
    </QueryClientProvider>
  );

  const view = render(renderSettings());

  return {
    onSaveAppSettings,
    onRefreshAppSettings,
    onSave,
    onClose,
    onSetPrivateKey,
    onReboot,
    onDisconnect,
    onReconnect,
    onAdvertise,
    onDiscoverMesh,
    onDiscoverRegions,
    rerenderDesktopSection: (desktopSection: SettingsSection) =>
      view.rerender(renderSettings(desktopSection)),
    setMobile,
    view,
  };
}

function setMatchMedia(matches: boolean) {
  let currentMatches = matches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return currentMatches;
    },
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => mediaQuery),
  });

  return (nextMatches: boolean) => {
    currentMatches = nextMatches;
    listeners.forEach((listener) => listener({ matches: nextMatches } as MediaQueryListEvent));
  };
}

function openRadioSection() {
  const radioToggle = screen.getByRole('button', { name: /^Radio$/i });
  fireEvent.click(radioToggle);
}

function openLocalSection() {
  const localToggle = screen.getByRole('button', { name: /Local Configuration/i });
  fireEvent.click(localToggle);
}

function openDatabaseSection() {
  const databaseToggle = screen.getByRole('button', { name: /Database/i });
  fireEvent.click(databaseToggle);
}

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getFanoutConfigs').mockResolvedValue([]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.style.fontSize = '';
  });

  it('refreshes app settings when opened', async () => {
    const { onRefreshAppSettings } = renderModal();

    await waitFor(() => {
      expect(onRefreshAppSettings).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes app settings in page mode even when open is false', async () => {
    const { onRefreshAppSettings } = renderModal({ open: false, pageMode: true });

    await waitFor(() => {
      expect(onRefreshAppSettings).toHaveBeenCalledTimes(1);
    });
  });

  it('does not render when closed outside page mode', () => {
    renderModal({ open: false });
    expect(screen.queryByLabelText('Preset')).not.toBeInTheDocument();
  });

  it('shows favorite-contact radio sync helper text in radio tab', async () => {
    renderModal();
    openRadioSection();

    expect(screen.getByText(/Configured radio contact capacity/i)).toBeInTheDocument();
  });

  it('renders flood and zero-hop advert buttons and passes the selected mode', async () => {
    const onAdvertise = vi.fn(async (_mode: RadioAdvertMode) => {});
    renderModal({ onAdvertise });
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Send Flood Advertisement' }));
    await waitFor(() => {
      expect(onAdvertise).toHaveBeenCalledWith('flood');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send Zero-Hop Advertisement' }));
    await waitFor(() => {
      expect(onAdvertise).toHaveBeenCalledWith('zero_hop');
    });
  });

  it('shows radio-unavailable message when config is null', () => {
    renderModal({ config: null });

    const radioToggle = screen.getByRole('button', { name: /^Radio$/i });
    expect(radioToggle).not.toBeDisabled();

    fireEvent.click(radioToggle);
    expect(screen.getByText('Radio is not available.')).toBeInTheDocument();
  });

  it('shows radio-unavailable message in sidebar-nav mode when config is null', () => {
    renderModal({
      config: null,
      externalSidebarNav: true,
      desktopSection: 'radio',
    });

    expect(screen.getByText('Radio is not available.')).toBeInTheDocument();
  });

  it('shows cached radio firmware and capacity info under the connection status', () => {
    renderModal({
      health: {
        ...baseHealth,
        radio_device_info: {
          model: 'T-Echo',
          firmware_build: '2025-02-01',
          firmware_version: '1.2.3',
          max_contacts: 350,
          max_channels: 64,
        },
      },
    });
    openRadioSection();

    expect(
      screen.getByText('T-Echo running 2025-02-01/1.2.3 (max: 350 contacts, 64 channels)')
    ).toBeInTheDocument();
  });

  it('shows and dispatches reconnect when radio connection is paused', async () => {
    const onReconnect = vi.fn(async () => {});
    renderModal({
      health: { ...baseHealth, radio_state: 'paused' },
      onReconnect,
    });
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
  });

  it('shows a ready Heltec transport as connected with a disconnect action', async () => {
    const onDisconnect = vi.fn(async () => {});
    renderModal({
      onDisconnect,
      health: {
        ...baseHealth,
        radio_connected: true,
        radio_state: 'ready',
        connection_info: 'Serial: /dev/ttyUSB0',
        radio_device_info: {
          model: 'Heltec V3',
          firmware_build: null,
          firmware_version: '1.17.1',
          max_contacts: 350,
          max_channels: 40,
        },
      },
    });
    openRadioSection();

    expect(screen.getByRole('status', { name: 'Serial: /dev/ttyUSB0' })).toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
  });

  it.each([
    {
      state: 'degraded' as const,
      connected: true,
      label: 'Connected (degraded at channel sync)',
      action: 'Disconnect',
      indicatorClass: 'bg-warning',
    },
    {
      state: 'failed' as const,
      connected: true,
      label: 'Connected — setup failed at device bootstrap',
      action: 'Disconnect',
      indicatorClass: 'bg-status-disconnected',
    },
    {
      state: 'initializing' as const,
      connected: true,
      label: 'Initializing Serial: /dev/ttyUSB0',
      action: 'Disconnect',
      indicatorClass: 'bg-warning',
    },
    {
      state: 'connecting' as const,
      connected: false,
      label: 'Attempting to connect to Serial: /dev/ttyUSB0',
      action: 'Stop Trying',
      indicatorClass: 'bg-warning',
    },
    {
      state: 'disconnected' as const,
      connected: false,
      label: 'Not connected',
      action: 'Stop Trying',
      indicatorClass: 'bg-status-disconnected',
    },
    {
      state: 'paused' as const,
      connected: false,
      label: 'Connection paused (Serial: /dev/ttyUSB0)',
      action: 'Reconnect',
      indicatorClass: 'bg-status-disconnected',
    },
  ])(
    'maps $state lifecycle state to truthful connection UI',
    ({ state, connected, label, action, indicatorClass }) => {
      renderModal({
        health: {
          ...baseHealth,
          radio_connected: connected,
          radio_state: state,
          startup_error_stage:
            state === 'degraded' ? 'channel sync' : state === 'failed' ? 'device bootstrap' : null,
        },
      });
      openRadioSection();

      const status = screen.getByRole('status', { name: label });
      expect(status).toBeInTheDocument();
      expect(status.firstElementChild).toHaveClass(indicatorClass);
      expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    }
  );

  it('uses physical transport presence when lifecycle state and connection disagree', () => {
    renderModal({
      health: { ...baseHealth, radio_connected: false, radio_state: 'ready' },
    });
    openRadioSection();

    expect(screen.getByRole('status', { name: 'Not connected' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('runs repeater mesh discovery from the radio tab', async () => {
    const { onDiscoverMesh } = renderModal();
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Discover Repeaters' }));

    await waitFor(() => {
      expect(onDiscoverMesh).toHaveBeenCalledWith('repeaters');
    });
  });

  it('renders mesh discovery results in the radio tab', () => {
    renderModal({
      meshDiscovery: {
        target: 'all',
        duration_seconds: 8,
        results: [
          {
            public_key: '11'.repeat(32),
            name: null,
            node_type: 'repeater',
            heard_count: 2,
            local_snr: 7.5,
            local_rssi: -101,
            remote_snr: 4,
          },
        ],
      },
    });
    openRadioSection();

    expect(screen.getByText('Last sweep: 1 node')).toBeInTheDocument();
    expect(screen.getByText('repeater')).toBeInTheDocument();
    expect(screen.getByText('heard 2 times')).toBeInTheDocument();
    expect(screen.getByText('8s listen window')).toBeInTheDocument();
  });

  it('discovers regions using repeaters from the last mesh sweep', async () => {
    const { onDiscoverRegions } = renderModal({
      meshDiscovery: {
        target: 'all',
        duration_seconds: 8,
        results: [
          {
            public_key: '11'.repeat(32),
            name: 'RPT-A',
            node_type: 'repeater',
            heard_count: 1,
            local_snr: 5,
            local_rssi: -100,
            remote_snr: 3,
          },
          {
            public_key: '22'.repeat(32),
            name: 'Sensor',
            node_type: 'sensor',
            heard_count: 1,
            local_snr: 5,
            local_rssi: -100,
            remote_snr: 3,
          },
        ],
      },
    });
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Discover Regions' }));

    // Only the repeater's key is passed, not the sensor's.
    await waitFor(() => {
      expect(onDiscoverRegions).toHaveBeenCalledWith(['11'.repeat(32)]);
    });
  });

  it('adds discovered regions to the known-regions field', () => {
    renderModal({
      regionDiscovery: {
        repeaters_queried: 2,
        repeaters_answered: 2,
        regions: ['nl-gr', 'de-by'],
        results: [],
      },
    });
    openRadioSection();

    expect(screen.getByText('2/2 repeaters answered — 2 regions found')).toBeInTheDocument();

    const knownRegions = screen.getByLabelText(
      'Known Regions (for decoding)'
    ) as HTMLTextAreaElement;
    fireEvent.change(knownRegions, { target: { value: 'nl-gr' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add to Known Regions' }));

    // Existing 'nl-gr' preserved, only the new 'de-by' appended.
    expect(knownRegions.value).toBe('nl-gr\nde-by');
  });

  it('saves advert location source through radio config save', async () => {
    const { onSave } = renderModal();
    openRadioSection();

    fireEvent.change(screen.getByLabelText('Advert Location Source'), {
      target: { value: 'off' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ advert_location_source: 'off' })
      );
    });
  });

  it('saves multi-acks through radio config save', async () => {
    const { onSave } = renderModal();
    openRadioSection();

    fireEvent.click(screen.getByLabelText('Extra Direct ACK Transmission'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ multi_acks_enabled: true }));
    });
  });

  it('shows and saves companion repeat mode when supported', async () => {
    const { onSave } = renderModal({
      config: {
        ...baseConfig,
        repeat_enabled: true,
        repeat_enabled_supported: true,
      },
    });
    openRadioSection();

    fireEvent.click(screen.getByLabelText('Companion Repeat Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ repeat_enabled: false }));
    });
  });

  it('rejects incomplete radio numbers and connects the accessible error to the fields', async () => {
    const { onSave } = renderModal();
    openRadioSection();

    const frequency = screen.getByLabelText('Frequency (MHz)');
    fireEvent.change(frequency, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('All numeric fields must contain complete, valid values');
    expect(frequency).toHaveAttribute('aria-invalid', 'true');
    expect(frequency).toHaveAttribute('aria-describedby', error.id);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps a disconnected-radio rejection beside the submitted radio fields', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('Radio disconnected');
    });
    renderModal({ onSave });
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Radio disconnected');
    expect(screen.getByLabelText('Frequency (MHz)')).toHaveAttribute('aria-describedby', error.id);
  });

  it('saves changed max contacts value through onSaveAppSettings', async () => {
    const { onSaveAppSettings } = renderModal();
    openRadioSection();

    const maxContactsInput = screen.getByLabelText('Max Contacts on Radio');
    fireEvent.change(maxContactsInput, { target: { value: '250' } });

    // Click the "Save Messaging Settings" button
    const saveButtons = screen.getAllByRole('button', { name: 'Save Messaging Settings' });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(onSaveAppSettings).toHaveBeenCalledWith({ max_radio_contacts: 250 });
    });
  });

  it('does not save max contacts when unchanged', async () => {
    const { onSaveAppSettings } = renderModal({
      appSettings: { ...baseSettings, max_radio_contacts: 200 },
    });
    openRadioSection();

    // Click the "Save Messaging Settings" button
    const saveButtons = screen.getAllByRole('button', { name: 'Save Messaging Settings' });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(onSaveAppSettings).not.toHaveBeenCalled();
    });
  });

  it('renders selected section from external sidebar nav on desktop mode', async () => {
    renderModal({
      externalSidebarNav: true,
      desktopSection: 'fanout',
    });

    await waitFor(() => {
      expect(api.getFanoutConfigs).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: 'Add Integration' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Local Configuration/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preset')).not.toBeInTheDocument();
  });

  it('does not clip the fanout add-integration menu in external desktop mode', async () => {
    renderModal({
      externalSidebarNav: true,
      desktopSection: 'fanout',
    });

    const addIntegrationButton = await screen.findByRole('button', { name: 'Add Integration' });
    const wrapperSection = addIntegrationButton.closest('section');
    expect(wrapperSection).not.toHaveClass('overflow-hidden');
  });

  it('applies the centered 800px column layout to non-fanout settings content', () => {
    renderModal({
      externalSidebarNav: true,
      desktopSection: 'local',
    });

    const localSettingsText = screen.getByText('These settings apply only to this device/browser.');
    expect(localSettingsText.closest('div')).toHaveClass('mx-auto', 'w-full', 'max-w-[800px]');
  });

  it('toggles sections in mobile accordion mode', () => {
    renderModal({ mobile: true });
    const localToggle = screen.getAllByRole('button', { name: /Local Configuration/i })[0];

    expect(screen.queryByLabelText('Preset')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Local label text')).not.toBeInTheDocument();

    fireEvent.click(localToggle);
    expect(screen.getByLabelText('Local label text')).toBeInTheDocument();

    fireEvent.click(localToggle);
    expect(screen.queryByLabelText('Local label text')).not.toBeInTheDocument();
  });

  it.each([
    ['radio', 'Radio'],
    ['local', 'Local Configuration'],
    ['radio-app', 'Radio-App Management'],
    ['fanout', 'MQTT & Automation'],
    ['database', 'Database'],
    ['statistics', 'Statistics'],
    ['about', 'About'],
  ] as const)('opens the routed %s section on mobile', async (desktopSection, accessibleName) => {
    renderModal({ mobile: true, externalSidebarNav: true, desktopSection });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: accessibleName })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
  });

  it('updates the open mobile section when browser navigation changes the route', async () => {
    const { rerenderDesktopSection } = renderModal({
      mobile: true,
      externalSidebarNav: true,
      desktopSection: 'radio',
    });

    const radioToggle = screen.getByRole('button', { name: 'Radio' });
    await waitFor(() => expect(radioToggle).toHaveAttribute('aria-expanded', 'true'));

    rerenderDesktopSection('fanout');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'MQTT & Automation' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expect(radioToggle).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('keeps an intentional mobile collapse until the route or layout changes', async () => {
    const { rerenderDesktopSection } = renderModal({
      mobile: true,
      externalSidebarNav: true,
      desktopSection: 'local',
    });
    const localToggle = screen.getByRole('button', { name: 'Local Configuration' });
    await waitFor(() => expect(localToggle).toHaveAttribute('aria-expanded', 'true'));

    localToggle.focus();
    fireEvent.click(localToggle);
    expect(localToggle).toHaveAttribute('aria-expanded', 'false');
    expect(localToggle).toHaveFocus();

    rerenderDesktopSection('local');
    expect(localToggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the routed section when resizing from desktop to mobile', async () => {
    const { setMobile } = renderModal({
      externalSidebarNav: true,
      desktopSection: 'database',
    });

    expect(screen.queryByRole('button', { name: 'Database' })).not.toBeInTheDocument();
    setMobile(true);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Database' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
  });

  it('lists the new Windows 95 and iPhone themes', () => {
    renderModal();
    openLocalSection();

    expect(screen.getByText('Windows 95')).toBeInTheDocument();
    expect(screen.getByText('iPhone')).toBeInTheDocument();
  });

  it('reports invalid local JSON beside the editor without persisting it', async () => {
    renderModal();
    openLocalSection();

    fireEvent.click(screen.getByLabelText('Replace as you Type'));
    const editor = screen.getByLabelText('Text replacement map (JSON)');
    fireEvent.change(editor, { target: { value: '{broken' } });

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Invalid JSON');
    expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(editor).toHaveAttribute('aria-describedby', error.id);
  });

  it('reverts checkbox state when auto-persist fails on the database section', async () => {
    // Auto-persist replaced the old "Save Settings" button on this section.
    // The risk is now: a toggle gets applied optimistically, the PATCH fails,
    // and we're left with the UI out of sync with saved state. Verify the
    // revert-on-error path keeps the checkbox consistent with the server.
    const onSaveAppSettings = vi.fn(async () => {
      throw new Error('Save failed');
    });

    renderModal({
      externalSidebarNav: true,
      desktopSection: 'database',
      onSaveAppSettings,
    });

    const checkbox = screen.getByRole('checkbox', {
      name: /Auto-decrypt historical DMs/i,
    }) as HTMLInputElement;
    const initialChecked = checkbox.checked;

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(onSaveAppSettings).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(checkbox.checked).toBe(initialChecked);
    });
  });

  it('serializes rapid auto-persist clicks so stale writes cannot win', async () => {
    // Regression test for a race where rapid consecutive checkbox toggles
    // fire overlapping PATCHes that can land out of order. The page now
    // chains saves through a single promise, so the server sees them in
    // the order the user clicked. This test hand-controls resolution
    // order to force the "stale write" scenario if serialization were off.

    const deferred: { resolve: () => void }[] = [];
    const callOrder: number[] = [];

    const onSaveAppSettings = vi.fn(async (_update: unknown) => {
      const index = deferred.length;
      callOrder.push(index);
      await new Promise<void>((res) => {
        deferred.push({ resolve: res });
      });
    });

    renderModal({
      externalSidebarNav: true,
      desktopSection: 'radio-app',
      onSaveAppSettings,
    });

    // Two distinct checkboxes in quick succession.
    const blockClients = screen.getByRole('checkbox', { name: /Block clients/i });
    const blockRepeaters = screen.getByRole('checkbox', { name: /Block repeaters/i });

    fireEvent.click(blockClients);
    fireEvent.click(blockRepeaters);

    // Wait for the first PATCH to be registered. Only the first should be
    // in-flight — the second must be queued behind it.
    await waitFor(() => {
      expect(deferred.length).toBe(1);
    });
    expect(callOrder).toEqual([0]);

    // Resolve the first PATCH. The chain should now dispatch the second.
    deferred[0].resolve();
    await waitFor(() => {
      expect(deferred.length).toBe(2);
    });
    expect(callOrder).toEqual([0, 1]);

    // Resolve the second so the test tears down cleanly.
    deferred[1].resolve();
    await waitFor(() => {
      expect(onSaveAppSettings).toHaveBeenCalledTimes(2);
    });
  });

  it('does not call onClose after save/reboot flows in page mode', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {});
    const onSetPrivateKey = vi.fn(async () => {});
    const onReboot = vi.fn(async () => {});

    renderModal({
      pageMode: true,
      onClose,
      onSave,
      onSetPrivateKey,
      onReboot,
      onDisconnect: vi.fn(async () => {}),
      onReconnect: vi.fn(async () => {}),
    });
    openRadioSection();

    fireEvent.click(screen.getByRole('button', { name: 'Save Radio Config & Reboot' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onReboot).toHaveBeenCalledTimes(1);
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Set Private Key (write-only)'), {
      target: { value: 'a'.repeat(64) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set Private Key & Reboot' }));

    await waitFor(() => {
      expect(onSetPrivateKey).toHaveBeenCalledWith('a'.repeat(64));
      expect(onReboot).toHaveBeenCalledTimes(2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stores and clears reopen-last-conversation preference locally', () => {
    const savedConversation = JSON.stringify({
      type: 'channel',
      id: 'stable-channel-key',
      name: 'Ops',
    });
    localStorage.setItem(LAST_VIEWED_CONVERSATION_KEY, savedConversation);
    renderModal();
    openLocalSection();

    const checkbox = screen.getByLabelText('Reopen Last Conversation');
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    expect(localStorage.getItem(REOPEN_LAST_CONVERSATION_KEY)).toBe('1');
    expect(localStorage.getItem(LAST_VIEWED_CONVERSATION_KEY)).toBe(savedConversation);

    fireEvent.click(checkbox);

    expect(localStorage.getItem(REOPEN_LAST_CONVERSATION_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_VIEWED_CONVERSATION_KEY)).toBeNull();
  });

  it('defaults the path-hop-width toggle to off and persists enabling it', () => {
    renderModal();
    openLocalSection();

    const checkbox = screen.getByLabelText('Show Path Hop Width');
    expect(checkbox).not.toBeChecked();
    expect(localStorage.getItem(SHOW_PATH_HOP_WIDTH_KEY)).toBeNull();

    fireEvent.click(checkbox);

    expect(localStorage.getItem(SHOW_PATH_HOP_WIDTH_KEY)).toBe('true');
  });

  it('defaults distance units to metric and stores local changes', () => {
    renderModal();
    openLocalSection();

    const select = screen.getByLabelText('Distance Units');
    expect(select).toHaveValue('metric');

    fireEvent.change(select, { target: { value: 'smoots' } });

    expect(localStorage.getItem(DISTANCE_UNIT_KEY)).toBe('smoots');
  });

  it('defaults relative font size to 100% and exposes the expected input bounds', () => {
    renderModal();
    openLocalSection();

    const slider = screen.getByLabelText('Relative font size slider');
    const input = screen.getByLabelText('Relative font size percentage');

    expect(slider).toHaveValue(String(DEFAULT_FONT_SCALE));
    expect(slider).toHaveAttribute('step', '5');
    expect(input).toHaveValue(DEFAULT_FONT_SCALE);
    expect(input).toHaveAttribute('min', String(MIN_FONT_SCALE));
    expect(input).toHaveAttribute('max', String(MAX_FONT_SCALE));
  });

  it('stores and applies relative font size changes locally', async () => {
    renderModal();
    openLocalSection();

    const slider = screen.getByLabelText('Relative font size slider');

    fireEvent.change(slider, { target: { value: '135' } });

    expect(localStorage.getItem(FONT_SCALE_KEY)).toBeNull();
    expect(document.documentElement.style.fontSize).toBe('');

    fireEvent.mouseUp(slider);

    await waitFor(() => {
      expect(localStorage.getItem(FONT_SCALE_KEY)).toBe('135');
      expect(document.documentElement.style.fontSize).toBe('135%');
    });

    fireEvent.change(screen.getByLabelText('Relative font size percentage'), {
      target: { value: '137.5' },
    });

    await waitFor(() => {
      expect(localStorage.getItem(FONT_SCALE_KEY)).toBe('137.5');
      expect(document.documentElement.style.fontSize).toBe('137.5%');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(localStorage.getItem(FONT_SCALE_KEY)).toBeNull();
      expect(document.documentElement.style.fontSize).toBe('100%');
    });
  });

  it('purges decrypted raw packets via maintenance endpoint action', async () => {
    const runMaintenanceSpy = vi.spyOn(api, 'runMaintenance').mockResolvedValue({
      packets_deleted: 12,
      vacuumed: true,
    });

    renderModal();
    openDatabaseSection();

    expect(
      screen.getByText(/removes packet-analysis availability for those messages/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Purge Archival Packets' }));

    await waitFor(() => {
      expect(runMaintenanceSpy).toHaveBeenCalledWith({ purgeLinkedRawPackets: true });
    });
  });

  it('validates cleanup numbers and honors destructive confirmation', async () => {
    const runMaintenanceSpy = vi.spyOn(api, 'runMaintenance').mockResolvedValue({
      packets_deleted: 0,
      vacuumed: false,
    });
    renderModal();
    openDatabaseSection();

    const days = screen.getByLabelText('Older than (days)');
    fireEvent.change(days, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('whole number from 1–365');
    expect(days).toHaveAttribute('aria-invalid', 'true');
    expect(days).toHaveAttribute('aria-describedby', error.id);
    expect(runMaintenanceSpy).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.change(days, { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(runMaintenanceSpy).not.toHaveBeenCalled();
  });

  it('renders statistics section with fetched data', async () => {
    const mockStats: StatisticsResponse = {
      busiest_channels_24h: [
        { channel_key: 'AA'.repeat(16), channel_name: 'general', message_count: 42 },
      ],
      contact_count: 10,
      repeater_count: 3,
      channel_count: 5,
      total_packets: 200,
      decrypted_packets: 150,
      undecrypted_packets: 50,
      total_dms: 25,
      total_channel_messages: 80,
      total_outgoing: 30,
      contacts_heard: { last_hour: 2, last_24_hours: 7, last_week: 10 },
      repeaters_heard: { last_hour: 1, last_24_hours: 3, last_week: 3 },
      known_channels_active: { last_hour: 1, last_24_hours: 4, last_week: 6 },
      path_hash_width_24h: {
        total_packets: 120,
        single_byte: 60,
        double_byte: 36,
        triple_byte: 24,
        single_byte_pct: 50,
        double_byte_pct: 30,
        triple_byte_pct: 20,
      },
      region_scope_24h: {
        total_messages: 120,
        scoped_messages: 40,
        scoped_pct: 33.3,
        false_positive_floor: 2,
        total_senders: 12,
        scoped_senders: 3,
        scoped_senders_pct: 25,
      },
      packets_per_hour_72h: [
        { timestamp: 1711792800, count: 12 },
        { timestamp: 1711796400, count: 8 },
      ],
      noise_floor_24h: {
        sample_interval_seconds: 60,
        coverage_seconds: 3600,
        latest_noise_floor_dbm: -105,
        latest_timestamp: 1711800000,
        samples: [],
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    renderModal({
      externalSidebarNav: true,
      desktopSection: 'statistics',
    });

    await waitFor(() => {
      expect(screen.getByText('Network')).toBeInTheDocument();
    });

    // Verify key labels are present
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.getByText('Repeaters')).toBeInTheDocument();
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
    expect(screen.getByText('Channel Messages')).toBeInTheDocument();
    expect(screen.getByText('Sent (Outgoing)')).toBeInTheDocument();
    expect(screen.getByText('Total stored')).toBeInTheDocument();
    expect(screen.getByText('Decrypted')).toBeInTheDocument();
    expect(screen.getByText('Undecrypted')).toBeInTheDocument();
    expect(screen.getByText('Path Hash Width (24h)')).toBeInTheDocument();
    expect(
      screen.getByText(/Parsed stored raw packets from the last 24 hours: 120/)
    ).toBeInTheDocument();
    expect(screen.getByText('Contacts heard')).toBeInTheDocument();
    expect(screen.getByText('Repeaters heard')).toBeInTheDocument();
    expect(screen.getByText('Known-channels active')).toBeInTheDocument();
    expect(screen.getByText('Busiest Channels (24h)')).toBeInTheDocument();
    expect(screen.getByText('Noise Floor (24h)')).toBeInTheDocument();
    expect(screen.getByText('Region Scope (24h)')).toBeInTheDocument();
    // Fractions, not bare percentages — the sample size matters at this sparsity
    expect(screen.getByText(/40 of 120/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 12/)).toBeInTheDocument();
    // 40 scoped is well above the floor of 2, so the percentage is shown
    expect(screen.getByText(/33\.3%/)).toBeInTheDocument();
    expect(
      screen.queryByText(/at or below the estimated false-positive floor/)
    ).not.toBeInTheDocument();
  });

  it('discloses the false-positive floor and withholds a sub-0.1% scoped share', async () => {
    const mockStats: StatisticsResponse = {
      busiest_channels_24h: [],
      contact_count: 0,
      repeater_count: 0,
      channel_count: 0,
      total_packets: 0,
      decrypted_packets: 0,
      undecrypted_packets: 0,
      total_dms: 0,
      total_channel_messages: 0,
      total_outgoing: 0,
      contacts_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      repeaters_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      known_channels_active: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      path_hash_width_24h: {
        total_packets: 0,
        single_byte: 0,
        double_byte: 0,
        triple_byte: 0,
        single_byte_pct: 0,
        double_byte_pct: 0,
        triple_byte_pct: 0,
      },
      // Mirrors real-world data: 70 "scoped" packets against a measured floor of
      // 60 is corrupt-capture noise, not adoption.
      region_scope_24h: {
        total_messages: 391757,
        scoped_messages: 70,
        scoped_pct: 0.0179,
        false_positive_floor: 60.3,
        total_senders: 117,
        scoped_senders: 3,
        scoped_senders_pct: 2.56,
      },
      packets_per_hour_72h: [],
      noise_floor_24h: {
        sample_interval_seconds: 60,
        coverage_seconds: 0,
        latest_noise_floor_dbm: null,
        latest_timestamp: null,
        samples: [],
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    renderModal({ externalSidebarNav: true, desktopSection: 'statistics' });

    await waitFor(() => {
      expect(screen.getByText('Region Scope (24h)')).toBeInTheDocument();
    });

    // 70 scoped sits just above the 60.3 floor, so most of it is corrupt captures
    expect(screen.getByText(/Includes an estimated 60 false positives/)).toBeInTheDocument();
    // 0.0179% would render as a meaningless "0.0%", so the share is withheld
    expect(screen.queryByText(/0\.0%/)).not.toBeInTheDocument();
    expect(screen.getByText(/70 of 391,757/)).toBeInTheDocument();
    // ...but the decryption-backed sender figure still stands
    expect(screen.getByText(/3 of 117/)).toBeInTheDocument();
    expect(screen.getByText(/2\.6%/)).toBeInTheDocument();
  });

  it('reports scoped traffic as noise when it is at or below the floor', async () => {
    const mockStats: StatisticsResponse = {
      busiest_channels_24h: [],
      contact_count: 0,
      repeater_count: 0,
      channel_count: 0,
      total_packets: 0,
      decrypted_packets: 0,
      undecrypted_packets: 0,
      total_dms: 0,
      total_channel_messages: 0,
      total_outgoing: 0,
      contacts_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      repeaters_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      known_channels_active: { last_hour: 0, last_24_hours: 0, last_week: 0 },
      path_hash_width_24h: {
        total_packets: 0,
        single_byte: 0,
        double_byte: 0,
        triple_byte: 0,
        single_byte_pct: 0,
        double_byte_pct: 0,
        triple_byte_pct: 0,
      },
      region_scope_24h: {
        total_messages: 5000,
        scoped_messages: 12,
        scoped_pct: 0.24,
        false_positive_floor: 20,
        total_senders: 40,
        scoped_senders: 0,
        scoped_senders_pct: 0,
      },
      packets_per_hour_72h: [],
      noise_floor_24h: {
        sample_interval_seconds: 60,
        coverage_seconds: 0,
        latest_noise_floor_dbm: null,
        latest_timestamp: null,
        samples: [],
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    renderModal({ externalSidebarNav: true, desktopSection: 'statistics' });

    await waitFor(() => {
      expect(screen.getByText('Region Scope (24h)')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/at or below the estimated false-positive floor \(20\)/)
    ).toBeInTheDocument();
    // Percentage withheld even though 0.24% would round visibly — it is noise
    expect(screen.queryByText(/0\.2%/)).not.toBeInTheDocument();
  });

  it('fetches statistics when expanded in mobile external-nav mode', async () => {
    const mockStats: StatisticsResponse = {
      busiest_channels_24h: [],
      contact_count: 10,
      repeater_count: 3,
      channel_count: 5,
      total_packets: 200,
      decrypted_packets: 150,
      undecrypted_packets: 50,
      total_dms: 25,
      total_channel_messages: 80,
      total_outgoing: 30,
      contacts_heard: { last_hour: 2, last_24_hours: 7, last_week: 10 },
      repeaters_heard: { last_hour: 1, last_24_hours: 3, last_week: 3 },
      known_channels_active: { last_hour: 1, last_24_hours: 4, last_week: 6 },
      path_hash_width_24h: {
        total_packets: 120,
        single_byte: 60,
        double_byte: 36,
        triple_byte: 24,
        single_byte_pct: 50,
        double_byte_pct: 30,
        triple_byte_pct: 20,
      },
      region_scope_24h: {
        total_messages: 0,
        scoped_messages: 0,
        scoped_pct: 0,
        false_positive_floor: 0,
        total_senders: 0,
        scoped_senders: 0,
        scoped_senders_pct: 0,
      },
      packets_per_hour_72h: [],
      noise_floor_24h: {
        sample_interval_seconds: 60,
        coverage_seconds: 0,
        latest_noise_floor_dbm: null,
        latest_timestamp: null,
        samples: [],
      },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url === '/api/radio/presets' ? { stale: false, presets: [] } : mockStats;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

    renderModal({
      mobile: true,
      externalSidebarNav: true,
      desktopSection: 'radio',
    });

    // The radio section eagerly loads optional presets; statistics must still
    // wait for the explicit expand.
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/statistics', expect.any(Object));
    fireEvent.click(screen.getByRole('button', { name: /Statistics/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/statistics', expect.any(Object));
    });

    await waitFor(() => {
      expect(screen.getByText('Network')).toBeInTheDocument();
    });
  });

  it('renders routed hourly checkbox and calls save on toggle', async () => {
    const onSaveAppSettings = vi.fn(async () => {});

    renderModal({
      externalSidebarNav: true,
      desktopSection: 'radio-app',
      onSaveAppSettings,
    });

    const checkbox = screen.getByRole('checkbox', {
      name: /Poll direct\/routed-path repeaters hourly/i,
    }) as HTMLInputElement;

    expect(checkbox).toBeInTheDocument();
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(onSaveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry_routed_hourly: true })
      );
    });
  });

  it('shows route badge per tracked repeater', async () => {
    const directKey = 'bb'.repeat(32);

    renderModal({
      externalSidebarNav: true,
      desktopSection: 'radio-app',
      appSettings: {
        ...baseSettings,
        tracked_telemetry_repeaters: [directKey],
      },
      trackedTelemetryRepeaters: [directKey],
      contacts: [
        {
          public_key: directKey,
          name: 'DirectRepeater',
          type: 2,
          flags: 0,
          direct_path: 'aabb',
          direct_path_len: 1,
          direct_path_hash_mode: 1,
          last_advert: null,
          lat: null,
          lon: null,
          last_seen: null,
          on_radio: false,
          favorite: false,
          last_contacted: null,
          last_read_at: null,
          first_seen: null,
          effective_route: { path: 'aabb', path_len: 1, path_hash_mode: 1 },
          effective_route_source: 'direct',
        },
      ],
    });

    expect(screen.getByText('DirectRepeater')).toBeInTheDocument();
    expect(screen.getByText('direct')).toBeInTheDocument();
  });
});
