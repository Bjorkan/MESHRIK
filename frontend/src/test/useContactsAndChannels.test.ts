/**
 * Tests for useContactsAndChannels hook.
 *
 * Focuses on pagination logic in fetchAllContacts (which fetches 1000 items
 * per page and continues until a page returns fewer than pageSize results).
 */

import { createElement, type PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useContactsAndChannels } from '../hooks/useContactsAndChannels';
import { fetchAllContacts } from '../prefetch';
import { api } from '../api';
import { createAppQueryClient } from '../queryClient';
import type { BulkCreateHashtagChannelsResult, Contact } from '../types';

// Mock api module
vi.mock('../api', () => ({
  api: {
    getContacts: vi.fn(),
    getChannels: vi.fn(),
    createContact: vi.fn(),
    createChannel: vi.fn(),
    bulkCreateHashtagChannels: vi.fn(),
    deleteContact: vi.fn(),
    deleteChannel: vi.fn(),
    decryptHistoricalPackets: vi.fn(),
    getUndecryptedPacketCount: vi.fn(),
  },
}));

// Mock prefetch — takePrefetchOrFetch calls the fetcher directly
vi.mock('../prefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prefetch')>()),
  takePrefetchOrFetch: vi.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
}));

// Mock sonner
vi.mock('../components/ui/sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function makeContact(suffix: string): Contact {
  const key = suffix.padStart(64, '0');
  return {
    public_key: key,
    name: `Contact-${suffix}`,
    type: 1,
    flags: 0,
    direct_path: null,
    direct_path_len: -1,
    direct_path_hash_mode: 0,
    last_advert: null,
    lat: null,
    lon: null,
    last_seen: null,
    on_radio: false,
    favorite: false,
    last_contacted: null,
    last_read_at: null,
    first_seen: null,
  };
}

function makeContacts(count: number, startIndex = 0): Contact[] {
  return Array.from({ length: count }, (_, i) =>
    makeContact(String(startIndex + i).padStart(4, '0'))
  );
}

describe('useContactsAndChannels', () => {
  const setActiveConversation = vi.fn();
  const removeConversationMessages = vi.fn();
  const pendingDeleteFallbackRef = { current: false };
  const hasSetDefaultConversation = { current: false };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getContacts).mockResolvedValue([]);
    vi.mocked(api.getChannels).mockResolvedValue([]);
    vi.mocked(api.getUndecryptedPacketCount).mockResolvedValue({ count: 0 });
    pendingDeleteFallbackRef.current = false;
    hasSetDefaultConversation.current = false;
  });

  afterEach(() => {
    onlineManager.setOnline(true);
    vi.restoreAllMocks();
  });

  function renderUseContactsAndChannels(queryClient = createAppQueryClient()) {
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return {
      ...renderHook(
        () =>
          useContactsAndChannels({
            setActiveConversation,
            pendingDeleteFallbackRef,
            hasSetDefaultConversation,
            removeConversationMessages,
          }),
        { wrapper }
      ),
      queryClient,
    };
  }

  it('reports pending and independently completed entity collections during partial loads', async () => {
    let resolveContacts!: (contacts: Contact[]) => void;
    vi.mocked(api.getContacts).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContacts = resolve;
      })
    );
    vi.mocked(api.getChannels).mockResolvedValueOnce([]);

    const { result } = renderUseContactsAndChannels();
    await waitFor(() => expect(result.current.channelsStatus).toBe('empty'));
    expect(result.current.contactsStatus).toBe('pending');
    expect(result.current.contacts).toEqual([]);

    await act(async () => resolveContacts([makeContact('partial')]));
    await waitFor(() => expect(result.current.contactsStatus).toBe('ready'));
    expect(result.current.contacts).toHaveLength(1);
  });

  it('reports an error instead of treating retained DB rows as a fresh success', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contact = makeContact('stale');
    vi.mocked(api.getContacts).mockResolvedValueOnce([contact]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderUseContactsAndChannels(queryClient);
    await waitFor(() => expect(result.current.contactsStatus).toBe('ready'));

    vi.mocked(api.getContacts).mockRejectedValueOnce(new Error('server unavailable'));
    await act(async () => {
      await result.current.refreshContacts();
    });

    await waitFor(() => expect(result.current.contactsStatus).toBe('error'));
    expect(result.current.contacts).toHaveLength(1);
    expect(result.current.contacts[0]).toMatchObject(contact);
    expect(result.current.contactsLoaded).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to fetch contacts:',
      expect.objectContaining({ message: 'server unavailable' })
    );
  });

  it('reports offline instead of pending or ready when collection fetches are paused', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderUseContactsAndChannels(queryClient);

    await waitFor(() => expect(result.current.contactsStatus).toBe('offline'));
    expect(result.current.channelsStatus).toBe('offline');
    expect(result.current.contactsLoaded).toBe(false);
    expect(result.current.channelsLoaded).toBe(false);
    expect(result.current.contacts).toEqual([]);
    expect(result.current.channels).toEqual([]);
  });

  describe('fetchAllContacts pagination', () => {
    it('returns contacts directly when fewer than page size', async () => {
      const contacts = makeContacts(50);
      vi.mocked(api.getContacts).mockResolvedValueOnce(contacts);

      let fetched: Contact[] = [];
      await act(async () => {
        fetched = await fetchAllContacts();
      });

      expect(fetched).toHaveLength(50);
      // Should only call once (no pagination needed)
      expect(api.getContacts).toHaveBeenCalledTimes(1);
      expect(api.getContacts).toHaveBeenCalledWith(1000, 0, undefined);
    });

    it('paginates when first page returns exactly page size', async () => {
      const page1 = makeContacts(1000, 0);
      const page2 = makeContacts(200, 1000);

      vi.mocked(api.getContacts)
        .mockResolvedValueOnce(page1) // First page: full
        .mockResolvedValueOnce(page2); // Second page: partial (done)

      let fetched: Contact[] = [];
      await act(async () => {
        fetched = await fetchAllContacts();
      });

      expect(fetched).toHaveLength(1200);
      expect(api.getContacts).toHaveBeenCalledTimes(2);
      expect(api.getContacts).toHaveBeenNthCalledWith(1, 1000, 0, undefined);
      expect(api.getContacts).toHaveBeenNthCalledWith(2, 1000, 1000, undefined);
    });

    it('paginates through multiple full pages', async () => {
      const page1 = makeContacts(1000, 0);
      const page2 = makeContacts(1000, 1000);
      const page3 = makeContacts(500, 2000);

      vi.mocked(api.getContacts)
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);

      let fetched: Contact[] = [];
      await act(async () => {
        fetched = await fetchAllContacts();
      });

      expect(fetched).toHaveLength(2500);
      expect(api.getContacts).toHaveBeenCalledTimes(3);
      expect(api.getContacts).toHaveBeenNthCalledWith(3, 1000, 2000, undefined);
    });

    it('handles exactly page size total (boundary case)', async () => {
      const page1 = makeContacts(1000, 0);
      const page2: Contact[] = []; // Empty second page

      vi.mocked(api.getContacts).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

      let fetched: Contact[] = [];
      await act(async () => {
        fetched = await fetchAllContacts();
      });

      expect(fetched).toHaveLength(1000);
      expect(api.getContacts).toHaveBeenCalledTimes(2);
    });
  });

  it('does not let an older contacts response overwrite a newer realtime update', async () => {
    let resolveContacts!: (contacts: Contact[]) => void;
    let requestSignal: AbortSignal | undefined;
    vi.mocked(api.getContacts).mockImplementationOnce((_limit, _offset, signal) => {
      requestSignal = signal;
      return new Promise<Contact[]>((resolve) => {
        resolveContacts = resolve;
      });
    });

    const { result } = renderUseContactsAndChannels();
    const liveContact = makeContact('live');
    const staleContact = makeContact('stale');

    await waitFor(() => expect(api.getContacts).toHaveBeenCalledTimes(1));
    act(() => result.current.setContacts([liveContact]));
    expect(requestSignal?.aborted).toBe(true);

    // Resolve the stale promise; the cancelled query must not overwrite the cache.
    await act(async () => resolveContacts([staleContact]));

    // The live data set by setContacts must survive the stale resolution.
    // Use waitFor to allow Query to process the stale result internally.
    await waitFor(() => expect(result.current.contacts).toHaveLength(1), { timeout: 1000 });
    expect(result.current.contacts[0]).toMatchObject(liveContact);
  });

  describe('bulk hashtag creation', () => {
    it('refreshes channels and returns the backend result', async () => {
      const resultPayload: BulkCreateHashtagChannelsResult = {
        created_channels: [
          {
            key: 'AA'.repeat(16),
            name: '#ops',
            is_hashtag: true,
            on_radio: false,
            last_read_at: null,
            favorite: false,
            muted: false,
          },
        ],
        existing_count: 1,
        invalid_names: [],
        decrypt_started: true,
        decrypt_total_packets: 12,
        message: 'Created 1 room',
      };
      vi.mocked(api.bulkCreateHashtagChannels).mockResolvedValueOnce(resultPayload);
      vi.mocked(api.getChannels).mockResolvedValue(resultPayload.created_channels);
      vi.mocked(api.getUndecryptedPacketCount).mockResolvedValueOnce({ count: 9 });

      const { result } = renderUseContactsAndChannels();

      let response: BulkCreateHashtagChannelsResult | null = null;
      await act(async () => {
        response = await result.current.handleBulkCreateHashtagChannels(['#ops'], true);
      });

      expect(api.bulkCreateHashtagChannels).toHaveBeenCalledWith(['#ops'], true);
      expect(api.getChannels).toHaveBeenCalled();
      expect(api.getUndecryptedPacketCount).toHaveBeenCalled();
      expect(response).toEqual(resultPayload);
    });
  });

  describe('contact creation', () => {
    it('shows one contextual result when requested historical decryption is unavailable', async () => {
      const { toast } = await import('../components/ui/sonner');
      const contact = makeContact('1');
      vi.mocked(api.createContact).mockResolvedValueOnce({
        ...contact,
        historical_decrypt: {
          status: 'unavailable_export',
          message: 'Set MESHCORE_STARTUP_EXPORT_PRIVATE_KEY=true to enable key export.',
        },
      });

      const { result } = renderUseContactsAndChannels();
      await act(async () => {
        await result.current.handleCreateContact('Alice', contact.public_key, true);
      });

      expect(toast.info).toHaveBeenCalledOnce();
      expect(toast.info).toHaveBeenCalledWith('Historical DM decryption unavailable', {
        description: 'Set MESHCORE_STARTUP_EXPORT_PRIVATE_KEY=true to enable key export.',
      });
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('contact deletion', () => {
    it('warns when the database delete succeeds but radio removal fails', async () => {
      const { toast } = await import('../components/ui/sonner');
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(api.deleteContact).mockResolvedValueOnce({
        status: 'partial',
        database_deleted: true,
        radio_deleted: false,
        radio_error: 'Radio rejected removal: contact locked',
      });
      vi.mocked(api.getChannels).mockResolvedValueOnce([]);

      const { result } = renderUseContactsAndChannels();
      await act(async () => {
        await result.current.handleDeleteContact(makeContact('1').public_key);
      });

      expect(toast.warning).toHaveBeenCalledWith(
        'Contact deleted from MESHRIK, but not from the radio',
        { description: 'Radio rejected removal: contact locked' }
      );
      expect(toast.success).not.toHaveBeenCalledWith('Contact deleted');
    });
  });
});
