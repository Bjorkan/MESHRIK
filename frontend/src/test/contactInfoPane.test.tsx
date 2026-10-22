import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ContactInfoPane } from '../components/ContactInfoPane';
import { toast } from '../components/ui/sonner';
import type { Contact, ContactAnalytics } from '../types';
import { renderWithRouter } from './renderWithRouter';
import { THEME_CHANGE_EVENT } from '../utils/theme';

const { getContactAnalytics, contactTelemetryHistory } = vi.hoisted(() => ({
  getContactAnalytics: vi.fn(),
  contactTelemetryHistory: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    getContactAnalytics,
    contactTelemetryHistory,
  },
  isAbortError: () => false,
}));

vi.mock('../components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/ContactAvatar', () => ({
  ContactAvatar: () => <div data-testid="contact-avatar" />,
}));

vi.mock('react-map-gl/maplibre', () => ({
  default: ({
    children,
    attributionControl,
    mapStyle,
  }: {
    children: React.ReactNode;
    attributionControl?: boolean;
    mapStyle?: string;
  }) => (
    <div
      data-testid="contact-embedded-map"
      data-default-attribution={String(attributionControl)}
      data-map-style={mapStyle}
    >
      {children}
    </div>
  ),
  AttributionControl: ({ compact }: { compact?: boolean }) => (
    <div data-testid="embedded-attribution" data-compact={String(compact)} />
  ),
  Marker: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Popup: ({
    children,
    closeOnClick,
    onClose,
  }: {
    children: React.ReactNode;
    closeOnClick?: boolean;
    onClose?: () => void;
  }) => (
    <div data-testid="contact-map-popup" data-close-on-click={String(closeOnClick)}>
      {children}
      <button type="button" onClick={onClose} aria-label="Simulate contact map background click" />
    </div>
  ),
}));

vi.mock('../components/ui/sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const mockedToast = vi.mocked(toast);

function createContact(overrides: Partial<Contact> = {}): Contact {
  return {
    public_key: 'AA'.repeat(32),
    name: 'Alice',
    type: 1,
    flags: 0,
    direct_path: null,
    direct_path_len: 0,
    direct_path_hash_mode: 0,
    last_advert: null,
    lat: null,
    lon: null,
    last_seen: 1700000000,
    on_radio: false,
    favorite: false,
    last_contacted: null,
    last_read_at: null,
    first_seen: 1699990000,
    ...overrides,
  };
}

function createAnalytics(
  contact: Contact | null,
  overrides: Partial<ContactAnalytics> = {}
): ContactAnalytics {
  return {
    lookup_type: contact ? 'contact' : 'name',
    name: contact?.name ?? 'Mystery',
    contact,
    name_first_seen_at: null,
    name_history: [],
    dm_message_count: 0,
    channel_message_count: 0,
    includes_direct_messages: Boolean(contact),
    most_active_rooms: [],
    advert_paths: [],
    advert_frequency: null,
    nearest_repeaters: [],
    hourly_activity: Array.from({ length: 24 }, (_, index) => ({
      bucket_start: 1_700_000_000 + index * 3600,
      last_24h_count: 0,
      last_week_average: 0,
      all_time_average: 0,
    })),
    weekly_activity: Array.from({ length: 26 }, (_, index) => ({
      bucket_start: 1_700_000_000 + index * 604800,
      message_count: 0,
    })),
    ...overrides,
  };
}

const baseProps = {
  fromChannel: false,
  onClose: () => {},
  contacts: [] as Contact[],
  config: null,
  onToggleFavorite: () => {},
  onSearchMessagesByKey: vi.fn(),
  onSearchMessagesByName: vi.fn(),
};

describe('ContactInfoPane', () => {
  beforeEach(() => {
    localStorage.clear();
    getContactAnalytics.mockReset();
    contactTelemetryHistory.mockReset();
    contactTelemetryHistory.mockResolvedValue([]);
    baseProps.onSearchMessagesByKey = vi.fn();
    baseProps.onSearchMessagesByName = vi.fn();
  });

  it('shows hop width when contact has a stored path hash mode', async () => {
    const contact = createContact({ direct_path_hash_mode: 1, direct_path_len: 1 });
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);

    await screen.findByText(contact.public_key);
    await waitFor(() => {
      expect(screen.getByText('Hop Width')).toBeInTheDocument();
      expect(screen.getByText('2-byte IDs')).toBeInTheDocument();
    });
  });

  it('reports a rejected contact-key copy without false success', async () => {
    const contact = createContact({ public_key: '56'.repeat(32) });
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);

    fireEvent.click(await screen.findByRole('button', { name: contact.public_key }));

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith('Copy failed', expect.anything())
    );
    expect(mockedToast.success).not.toHaveBeenCalledWith('Public key copied!');
  });

  it('does not show hop width for flood-routed contacts', async () => {
    const contact = createContact({ direct_path_len: -1, direct_path_hash_mode: -1 });
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);

    await screen.findByText('Alice');
    await waitFor(() => {
      expect(screen.queryByText('Hop Width')).not.toBeInTheDocument();
      expect(screen.getByText('Flood')).toBeInTheDocument();
    });
  });

  it('shows forced routing override and learned route separately', async () => {
    const contact = createContact({
      direct_path_len: 1,
      direct_path_hash_mode: 0,
      route_override_path: 'ae92f13e',
      route_override_len: 2,
      route_override_hash_mode: 1,
    });
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);

    await screen.findByText('Alice');
    await waitFor(() => {
      expect(screen.getByText('Routing')).toBeInTheDocument();
      expect(screen.getByText('(forced)')).toBeInTheDocument();
      expect(screen.getByText('Learned Route')).toBeInTheDocument();
      expect(screen.getByText('1 hop')).toBeInTheDocument();
    });
  });

  it('loads name-only channel stats and most active channels', async () => {
    getContactAnalytics.mockResolvedValue(
      createAnalytics(null, {
        lookup_type: 'name',
        name: 'Mystery',
        name_first_seen_at: 1_699_999_000,
        channel_message_count: 4,
        most_active_rooms: [
          {
            channel_key: 'ab'.repeat(16),
            channel_name: '#ops',
            message_count: 3,
          },
        ],
        hourly_activity: Array.from({ length: 24 }, (_, index) => ({
          bucket_start: 1_700_000_000 + index * 3600,
          last_24h_count: index === 23 ? 2 : 0,
          last_week_average: index === 23 ? 1.5 : 0,
          all_time_average: index === 23 ? 1.2 : 0,
        })),
        weekly_activity: Array.from({ length: 26 }, (_, index) => ({
          bucket_start: 1_700_000_000 + index * 604800,
          message_count: index === 25 ? 4 : 0,
        })),
      })
    );

    render(<ContactInfoPane {...baseProps} contactKey="name:Mystery" fromChannel />);

    await screen.findByText('Mystery');
    await waitFor(() => {
      expect(getContactAnalytics).toHaveBeenCalledWith(
        { name: 'Mystery' },
        expect.any(AbortSignal)
      );
      expect(screen.getByText('Messages')).toBeInTheDocument();
      expect(screen.getByText('Channel Messages')).toBeInTheDocument();
      expect(screen.getByText('4', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByText('Name First In Use')).toBeInTheDocument();
      expect(screen.getByText('Messages Per Hour')).toBeInTheDocument();
      expect(screen.getByText('Messages Per Week')).toBeInTheDocument();
      expect(screen.getByText('Most Active Channels')).toBeInTheDocument();
      expect(screen.getByText('#ops')).toBeInTheDocument();
      expect(
        screen.getByText(/Name-only analytics include channel messages only/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/same sender name/i)).toBeInTheDocument();
      expect(screen.getByText("Search user's messages by name")).toBeInTheDocument();
    });
  });

  it('fires the name search callback from the name-only pane', async () => {
    getContactAnalytics.mockResolvedValue(
      createAnalytics(null, { lookup_type: 'name', name: 'Mystery' })
    );

    render(<ContactInfoPane {...baseProps} contactKey="name:Mystery" fromChannel />);

    const button = await screen.findByRole('button', { name: "Search user's messages by name" });
    button.click();

    expect(baseProps.onSearchMessagesByName).toHaveBeenCalledWith('Mystery');
  });

  it('shows alias note in the channel attribution warning for keyed contacts', async () => {
    const contact = createContact();
    getContactAnalytics.mockResolvedValue(
      createAnalytics(contact, {
        name_history: [
          { name: 'Alice', first_seen: 1000, last_seen: 2000 },
          { name: 'AliceOld', first_seen: 900, last_seen: 999 },
        ],
      })
    );

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} fromChannel />);

    await screen.findByText(contact.public_key);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Also Known As' })).toBeInTheDocument();
      expect(
        screen.getByText(
          /may include messages previously attributed under names shown in Also Known As/i
        )
      ).toBeInTheDocument();
      expect(screen.getByText("Search user's messages by key")).toBeInTheDocument();
    });
  });

  it('fires the key search callback from the keyed pane', async () => {
    const contact = createContact();
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);

    const button = await screen.findByRole('button', { name: "Search user's messages by key" });
    button.click();

    expect(baseProps.onSearchMessagesByKey).toHaveBeenCalledWith(contact.public_key);
  });

  it('opens contact coordinates in the current map view and closes the pane', async () => {
    const contact = createContact({ lat: 59.3293, lon: 18.0686 });
    const onClose = vi.fn();
    const windowOpen = vi.spyOn(window, 'open');
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));

    await renderWithRouter(
      <ContactInfoPane
        {...baseProps}
        contactKey={contact.public_key}
        contacts={[contact]}
        onClose={onClose}
      />
    );

    const mapLink = await screen.findByRole('link', { name: 'View Alice on map' });
    expect(mapLink).toHaveAttribute('href', `/map?focus=${contact.public_key}`);
    expect(mapLink).not.toHaveAttribute('target');
    fireEvent.click(mapLink);

    expect(onClose).toHaveBeenCalledOnce();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('supports keyboard map navigation and Back in a narrow viewport', async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));
    try {
      const user = userEvent.setup();
      const contact = createContact({
        public_key: '12'.repeat(32),
        name: 'Synthetic Node',
        lat: 12.34567,
        lon: -45.6789,
      });
      const onClose = vi.fn();
      getContactAnalytics.mockResolvedValue(createAnalytics(contact));

      const { router } = await renderWithRouter(
        <ContactInfoPane
          {...baseProps}
          contactKey={contact.public_key}
          contacts={[contact]}
          onClose={onClose}
        />
      );
      const mapLink = await screen.findByRole('link', { name: 'View Synthetic Node on map' });

      mapLink.focus();
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/map');
        expect(router.state.location.search).toEqual({ focus: contact.public_key });
      });
      expect(onClose).toHaveBeenCalledOnce();

      act(() => router.history.back());
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('uses collapsed attribution in the contact telemetry map', async () => {
    const contact = createContact();
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));
    contactTelemetryHistory.mockResolvedValue([
      {
        timestamp: 1_700_000_000,
        data: {
          lpp_sensors: [
            {
              channel: 1,
              type_name: 'gps',
              value: { latitude: 59.3293, longitude: 18.0686 },
            },
          ],
        },
      },
    ]);

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);
    fireEvent.click(await screen.findByRole('button', { name: /GPS:/ }));

    expect(screen.getByTestId('embedded-attribution')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByTestId('embedded-attribution').parentElement).toHaveAttribute(
      'data-default-attribution',
      'false'
    );
  });

  it('closes the contact telemetry popup on map background click', async () => {
    const contact = createContact();
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));
    contactTelemetryHistory.mockResolvedValue([
      {
        timestamp: 1_700_000_000,
        data: {
          lpp_sensors: [
            {
              channel: 1,
              type_name: 'gps',
              value: { latitude: 59.3293, longitude: 18.0686 },
            },
          ],
        },
      },
    ]);

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);
    fireEvent.click(await screen.findByRole('button', { name: /GPS:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Alice on map' }));

    expect(screen.getByTestId('contact-map-popup')).toHaveAttribute('data-close-on-click', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate contact map background click' }));
    expect(screen.queryByTestId('contact-map-popup')).not.toBeInTheDocument();
  });

  it('keeps the contact popup open while changing the theme style in place', async () => {
    const contact = createContact();
    getContactAnalytics.mockResolvedValue(createAnalytics(contact));
    contactTelemetryHistory.mockResolvedValue([
      {
        timestamp: 1_700_000_000,
        data: {
          lpp_sensors: [
            {
              channel: 1,
              type_name: 'gps',
              value: { latitude: 59.3293, longitude: 18.0686 },
            },
          ],
        },
      },
    ]);

    render(<ContactInfoPane {...baseProps} contactKey={contact.public_key} />);
    fireEvent.click(await screen.findByRole('button', { name: /GPS:/ }));
    const map = screen.getByTestId('contact-embedded-map');
    fireEvent.click(screen.getByRole('button', { name: 'Show Alice on map' }));

    localStorage.setItem('meshrik-theme', 'light');
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'light' }));

    await waitFor(() =>
      expect(screen.getByTestId('contact-embedded-map')).toHaveAttribute(
        'data-map-style',
        'https://tiles.openfreemap.org/styles/liberty'
      )
    );
    expect(screen.getByTestId('contact-embedded-map')).toBe(map);
    expect(screen.getByTestId('contact-map-popup')).toHaveTextContent('Alice');
  });
});
