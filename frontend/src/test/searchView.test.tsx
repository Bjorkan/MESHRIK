import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { fireEvent, render as testingRender, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';

const mockGetMessages = vi.fn<(...args: unknown[]) => Promise<Message[]>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('../api', () => ({
  api: {
    getMessages: (...args: unknown[]) => mockGetMessages(...args),
  },
  isAbortError: (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
}));

import { SearchView } from '../components/SearchView';

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return testingRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function createSearchResult(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    type: 'CHAN',
    conversation_key: 'ABC123',
    text: 'hello world',
    sender_timestamp: 1700000000,
    received_at: 1700000000,
    paths: null,
    txt_type: 0,
    signature: null,
    sender_key: null,
    outgoing: false,
    acked: 0,
    sender_name: 'Alice',
    ...overrides,
  };
}

const defaultProps = {
  contacts: [],
  channels: [
    {
      key: 'ABC123',
      name: 'Public',
      is_hashtag: true,
      on_radio: false,
      last_read_at: null,
      favorite: false,
      muted: false,
    },
  ],
  onNavigateToMessage: vi.fn(),
};

/** Type the query into the search input and wait for debounced results to render. */
async function typeAndWaitForResults(query: string) {
  const input = screen.getByLabelText('Search messages');
  // Use fake timers only for the debounce, then switch to real timers for
  // React's async state updates and waitFor polling.
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.change(input, { target: { value: query } });
    await vi.advanceTimersByTimeAsync(350);
    await vi.runOnlyPendingTimersAsync();
  });
  vi.useRealTimers();
  await waitFor(() => expect(mockGetMessages).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
}

describe('SearchView', () => {
  beforeEach(() => {
    notifyManager.setScheduler((callback) => callback());
    vi.clearAllMocks();
    mockGetMessages.mockReset();
  });

  afterEach(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
  });

  it('renders empty state with prompt text', () => {
    mockGetMessages.mockResolvedValue([]);
    render(<SearchView {...defaultProps} />);
    expect(screen.getByText('Type to search across all messages')).toBeInTheDocument();
    expect(screen.getByText(/Tip: use/i)).toBeInTheDocument();
    expect(
      screen.getByText(/User-key linkage for group messages is best-effort/i)
    ).toBeInTheDocument();
  });

  it('focuses input on mount', () => {
    mockGetMessages.mockResolvedValue([]);
    render(<SearchView {...defaultProps} />);
    expect(screen.getByLabelText('Search messages')).toHaveFocus();
  });

  it('debounces search input', async () => {
    mockGetMessages.mockResolvedValue([]);
    vi.useFakeTimers();
    render(<SearchView {...defaultProps} />);

    const input = screen.getByLabelText('Search messages');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'hello' } });
    });

    // Should not have called API yet (within debounce window)
    expect(mockGetMessages).not.toHaveBeenCalled();

    // Advance past debounce timer
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();

    expect(mockGetMessages).toHaveBeenCalledTimes(1);
    expect(mockGetMessages).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'hello' }),
      expect.any(AbortSignal)
    );
  });

  it('uses route search as the committed query and navigates on debounced edits', async () => {
    mockGetMessages.mockResolvedValue([]);
    const onSearchQueryChange = vi.fn();
    const { rerender } = render(
      <SearchView
        {...defaultProps}
        searchQuery="user:Alice"
        onSearchQueryChange={onSearchQueryChange}
      />
    );

    await act(async () => await Promise.resolve());
    expect(screen.getByLabelText('Search messages')).toHaveValue('user:Alice');
    expect(mockGetMessages).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'user:Alice' }),
      expect.any(AbortSignal)
    );

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search messages'), {
        target: { value: 'channel:Public status' },
      });
      vi.advanceTimersByTime(350);
    });
    expect(onSearchQueryChange).toHaveBeenCalledWith('channel:Public status');
    vi.useRealTimers();

    rerender(
      <SearchView
        {...defaultProps}
        searchQuery="restored by Back"
        onSearchQueryChange={onSearchQueryChange}
      />
    );
    expect(screen.getByLabelText('Search messages')).toHaveValue('restored by Back');
  });

  it('keeps loading visible when an older aborted search settles', async () => {
    const first = deferred<Message[]>();
    const second = deferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SearchView {...defaultProps} />);

    const input = screen.getByLabelText('Search messages');
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'first' } });
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();
    expect(mockGetMessages).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'second' } });
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();
    expect(mockGetMessages).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Searching...');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    await act(async () => {
      first.reject(new DOMException('Aborted', 'AbortError'));
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Searching...');

    await act(async () => {
      second.resolve([]);
      await second.promise;
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByText(/No messages found for “second”/)).toBeInTheDocument();
  });

  it('displays search results', async () => {
    mockGetMessages.mockResolvedValue([
      createSearchResult({ id: 1, text: 'hello world', sender_name: 'Alice' }),
      createSearchResult({ id: 2, text: 'hello there', sender_name: 'Bob' }),
    ]);
    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('hello');

    // Text is split by highlightMatch into segments, so use container text content
    const links = screen.getAllByRole('link');
    const texts = links.map((link) => link.textContent);
    expect(texts.some((t) => t?.includes('hello world') || t?.includes('world'))).toBe(true);
    expect(texts.some((t) => t?.includes('hello there') || t?.includes('there'))).toBe(true);
  });

  it('shows no-results message when search returns empty', async () => {
    mockGetMessages.mockResolvedValue([]);
    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('nonexistent');

    expect(screen.getByText(/No messages found/)).toBeInTheDocument();
  });

  it.each([
    ['server error', new Error('500 Internal Server Error')],
    ['timeout', new Error('Request timed out')],
    ['offline', new TypeError('Failed to fetch')],
  ])('shows an actionable error instead of an empty state for %s', async (_label, error) => {
    mockGetMessages.mockRejectedValueOnce(error).mockResolvedValueOnce([]);
    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('unavailable');

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed');
    expect(screen.queryByText(/No messages found/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await act(async () => await Promise.resolve());

    expect(mockGetMessages).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/No messages found/)).toBeInTheDocument();
  });

  it('navigates to message on click', async () => {
    const result = createSearchResult({
      id: 42,
      type: 'CHAN',
      conversation_key: 'ABC123',
      text: 'click me',
    });
    mockGetMessages.mockResolvedValue([result]);
    const onNavigate = vi.fn();

    render(<SearchView {...defaultProps} onNavigateToMessage={onNavigate} />);

    await typeAndWaitForResults('click');

    const resultLink = screen.getByRole('link', { name: /click me/i });
    expect(resultLink).toHaveAttribute('href', '/channel/ABC123?message=42');

    fireEvent.click(resultLink);

    expect(onNavigate).toHaveBeenCalledWith({
      id: 42,
      type: 'CHAN',
      conversation_key: 'ABC123',
      conversation_name: 'Public',
    });
  });

  it('uses native link keyboard and modifier semantics', async () => {
    mockGetMessages.mockResolvedValue([createSearchResult({ id: 10, text: 'keyboard nav' })]);
    const onNavigate = vi.fn();
    render(<SearchView {...defaultProps} onNavigateToMessage={onNavigate} />);

    await typeAndWaitForResults('keyboard');

    const resultEl = screen.getByRole('link', { name: /keyboard nav/i });
    fireEvent.click(resultEl, { ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    resultEl.focus();
    await userEvent.setup().keyboard('{Enter}');

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('shows load more button when results fill a page', async () => {
    const pageResults = Array.from({ length: 50 }, (_, i) =>
      createSearchResult({ id: i + 1, text: `result ${i}` })
    );
    mockGetMessages.mockResolvedValueOnce(pageResults);

    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('result');

    expect(screen.getByText('Load more results')).toBeInTheDocument();
  });

  it('does not show load more when results are less than page size', async () => {
    mockGetMessages.mockResolvedValue([createSearchResult({ id: 1, text: 'only one' })]);

    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('only');

    const resultLinks = screen.getAllByRole('link');
    expect(resultLinks.some((link) => link.textContent?.includes('one'))).toBe(true);
    expect(screen.queryByText('Load more results')).not.toBeInTheDocument();
  });

  it('keeps loaded results and retries the same page after pagination fails', async () => {
    const pageResults = Array.from({ length: 50 }, (_, i) =>
      createSearchResult({ id: i + 1, text: `result ${i}` })
    );
    mockGetMessages
      .mockResolvedValueOnce(pageResults)
      .mockRejectedValueOnce(new Error('page failed'))
      .mockResolvedValueOnce([createSearchResult({ id: 51, text: 'recovered result' })]);
    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('result');
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your existing results are unchanged'
    );
    expect(screen.getByRole('link', { name: /result 0/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    await act(async () => await Promise.resolve());

    expect(mockGetMessages.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ q: 'result', offset: 50 })
    );
    expect(mockGetMessages.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ q: 'result', offset: 50 })
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Message search results')).toHaveStyle({ height: '4182px' });
  });

  it('resolves channel name from channels prop', async () => {
    mockGetMessages.mockResolvedValue([
      createSearchResult({ id: 1, type: 'CHAN', conversation_key: 'ABC123', text: 'test' }),
    ]);

    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('test');

    expect(screen.getByText('Public')).toBeInTheDocument();
  });

  it('resolves contact name from contacts prop', async () => {
    const contactKey = 'aa'.repeat(32);
    mockGetMessages.mockResolvedValue([
      createSearchResult({
        id: 1,
        type: 'PRIV',
        conversation_key: contactKey,
        text: 'dm test',
      }),
    ]);

    render(
      <SearchView
        {...defaultProps}
        contacts={[
          {
            public_key: contactKey,
            name: 'Bob',
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
            first_seen: null,
            last_read_at: null,
          },
        ]}
      />
    );

    await typeAndWaitForResults('dm');

    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('passes raw operator queries to the API and highlights only free text', async () => {
    mockGetMessages.mockResolvedValue([createSearchResult({ text: 'hello world' })]);

    render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('user:Alice hello');

    expect(mockGetMessages).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'user:Alice hello' }),
      expect.any(AbortSignal)
    );
    expect(screen.getByText('hello', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.queryByText('user:Alice', { selector: 'mark' })).not.toBeInTheDocument();
  });

  it('refetches current results when visibility policy changes', async () => {
    mockGetMessages
      .mockResolvedValueOnce([createSearchResult({ id: 1, text: 'visible result' })])
      .mockResolvedValueOnce([]);

    const { rerender } = render(<SearchView {...defaultProps} visibilityVersion={0} />);

    await typeAndWaitForResults('visible');
    expect(mockGetMessages).toHaveBeenCalledTimes(1);
    expect(
      screen.getAllByRole('link').some((link) => link.textContent?.includes('visible result'))
    ).toBe(true);

    rerender(<SearchView {...defaultProps} visibilityVersion={1} />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetMessages).toHaveBeenCalledTimes(2);
    expect(mockGetMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'visible' }),
      expect.any(AbortSignal)
    );
    expect(screen.getByText(/No messages found/)).toBeInTheDocument();
  });

  it('refocuses an already-mounted search input for a new scoped focus request', () => {
    const { rerender } = render(<SearchView {...defaultProps} focusRequestVersion={0} />);
    const input = screen.getByLabelText('Search messages');
    expect(input).toHaveFocus();

    input.blur();
    expect(input).not.toHaveFocus();
    rerender(<SearchView {...defaultProps} focusRequestVersion={1} />);

    expect(input).toHaveFocus();
  });

  it('aborts the load-more request on unmount', async () => {
    const pageResults = Array.from({ length: 50 }, (_, i) =>
      createSearchResult({ id: i + 1, text: `result ${i}` })
    );
    let resolveLoadMore: ((value: Message[]) => void) | null = null;
    mockGetMessages.mockResolvedValueOnce(pageResults).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          resolveLoadMore = resolve;
        })
    );

    const { unmount } = render(<SearchView {...defaultProps} />);

    await typeAndWaitForResults('result');
    fireEvent.click(screen.getByText('Load more results'));

    const loadMoreSignal = mockGetMessages.mock.calls[1]?.[1] as AbortSignal | undefined;
    expect(loadMoreSignal).toBeInstanceOf(AbortSignal);
    expect(loadMoreSignal?.aborted).toBe(false);

    unmount();

    expect(loadMoreSignal?.aborted).toBe(true);

    await act(async () => {
      resolveLoadMore?.([createSearchResult({ id: 99, text: 'late result' })]);
      await Promise.resolve();
    });
  });

  it('keeps refetch loading visible when an aborted load-more request settles', async () => {
    const pageResults = Array.from({ length: 50 }, (_, i) =>
      createSearchResult({ id: i + 1, text: `result ${i}` })
    );
    const loadMore = deferred<Message[]>();
    const refetch = deferred<Message[]>();
    mockGetMessages
      .mockResolvedValueOnce(pageResults)
      .mockReturnValueOnce(loadMore.promise)
      .mockReturnValueOnce(refetch.promise);

    const { rerender } = render(<SearchView {...defaultProps} visibilityVersion={0} />);
    await typeAndWaitForResults('result');
    fireEvent.click(screen.getByText('Load more results'));
    expect(screen.getByRole('status')).toHaveTextContent('Loading more...');

    rerender(<SearchView {...defaultProps} visibilityVersion={1} />);
    expect(mockGetMessages).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('status')).toHaveTextContent('Searching...');

    await act(async () => {
      loadMore.reject(new DOMException('Aborted', 'AbortError'));
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Searching...');

    await act(async () => {
      refetch.resolve([]);
      await refetch.promise;
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
