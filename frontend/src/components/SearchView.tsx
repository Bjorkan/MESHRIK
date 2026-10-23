import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDebouncer } from '@tanstack/react-pacer';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../api';
import { LoadingIndicator } from './ui/loading-indicator';
import { queryKeys } from '../queryClient';
import type { Contact, Channel } from '../types';
import { formatTime } from '../utils/messageParser';
import {
  measureElementWithFallback,
  observeElementRectWithFallback,
} from '../utils/virtualization';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

const SEARCH_PAGE_SIZE = 50;
const DEBOUNCE_MS = 300;
const ESTIMATED_RESULT_HEIGHT = 82;

interface SearchResult {
  id: number;
  type: 'PRIV' | 'CHAN';
  conversation_key: string;
  text: string;
  received_at: number;
  outgoing: boolean;
  sender_name: string | null;
}

const SEARCH_OPERATOR_RE = /(?<!\S)(user|channel):(?:"((?:[^"\\]|\\.)*)"|(\S+))/gi;

export interface SearchNavigateTarget {
  id: number;
  type: 'PRIV' | 'CHAN';
  conversation_key: string;
  conversation_name: string;
}

export interface SearchViewProps {
  contacts: Contact[];
  channels: Channel[];
  visibilityVersion?: number;
  focusRequestVersion?: number;
  visible?: boolean;
  onNavigateToMessage: (target: SearchNavigateTarget) => void;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
}

function highlightMatch(text: string, query: string): React.ReactNode[] {
  if (!query) return [text];
  const parts: React.ReactNode[] = [];
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const segments = text.split(regex);
  for (let i = 0; i < segments.length; i++) {
    if (regex.test(segments[i])) {
      parts.push(
        <mark key={i} className="bg-primary/30 text-foreground rounded-sm px-0.5">
          {segments[i]}
        </mark>
      );
    } else {
      parts.push(segments[i]);
    }
    // Reset lastIndex since we're using test() in a loop
    regex.lastIndex = 0;
  }
  return parts;
}

function getHighlightQuery(query: string): string {
  const fragments: string[] = [];
  let lastIndex = 0;
  let foundOperator = false;

  for (const match of query.matchAll(SEARCH_OPERATOR_RE)) {
    foundOperator = true;
    fragments.push(query.slice(lastIndex, match.index));
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  if (!foundOperator) {
    return query;
  }

  fragments.push(query.slice(lastIndex));
  return fragments
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .join(' ');
}

export function SearchView({
  contacts,
  channels,
  visibilityVersion = 0,
  focusRequestVersion = 0,
  visible = true,
  onNavigateToMessage,
  searchQuery,
  onSearchQueryChange,
}: SearchViewProps) {
  useLingui();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const retainedScrollOffsetRef = useRef(0);
  const focusedResultIdRef = useRef<number | null>(null);
  const wasVisibleRef = useRef(visible);
  const committedQuery = searchQuery !== undefined ? searchQuery : debouncedQuery;
  const highlightQuery = getHighlightQuery(committedQuery);
  const searchResultsQuery = useInfiniteQuery({
    queryKey: queryKeys.messageSearch(committedQuery, visibilityVersion),
    queryFn: ({ pageParam, signal }) =>
      api.getMessages(
        { q: committedQuery, limit: SEARCH_PAGE_SIZE, offset: pageParam },
        signal
      ) as Promise<SearchResult[]>,
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.length >= SEARCH_PAGE_SIZE ? lastPageParam + lastPage.length : undefined,
    enabled: committedQuery.length > 0,
  });
  const results = useMemo(() => {
    const uniqueResults = new Map<number, SearchResult>();
    for (const page of searchResultsQuery.data?.pages ?? []) {
      for (const result of page) uniqueResults.set(result.id, result);
    }
    return [...uniqueResults.values()];
  }, [searchResultsQuery.data]);
  const initialError = searchResultsQuery.isError && results.length === 0;
  const paginationError = searchResultsQuery.isFetchNextPageError && results.length > 0;
  const loading = searchResultsQuery.isFetching;
  const queryDebouncer = useDebouncer(
    (nextQuery: string) => {
      if (onSearchQueryChange) onSearchQueryChange(nextQuery);
      else setDebouncedQuery(nextQuery);
    },
    {
      key: 'message-search',
      wait: DEBOUNCE_MS,
    }
  );
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => resultsRef.current,
    estimateSize: () => ESTIMATED_RESULT_HEIGHT,
    getItemKey: (index) => results[index]?.id ?? `search-result-${index}`,
    overscan: 8,
    measureElement: measureElementWithFallback(() => ESTIMATED_RESULT_HEIGHT),
    observeElementRect: observeElementRectWithFallback(),
  });

  // Search is latest-value work: Pacer discards superseded drafts before Query fetches.
  useEffect(() => {
    queryDebouncer.maybeExecute(query.trim());
  }, [query, queryDebouncer]);

  useEffect(() => {
    if (searchQuery === undefined) return;
    queryDebouncer.cancel();
    setQuery(searchQuery);
    setDebouncedQuery(searchQuery);
  }, [queryDebouncer, searchQuery]);

  // Reset results when query changes
  useEffect(() => {
    retainedScrollOffsetRef.current = 0;
    virtualizer.scrollToOffset(0);
  }, [committedQuery, visibilityVersion, virtualizer]);

  // AppShell keeps SearchView mounted while a result route is open. A display:none
  // ancestor gives Virtual a zero-sized viewport, so retain and restore the real
  // scroll offset explicitly when the view becomes visible again. Restore focus
  // after Virtual has rebuilt the retained window so keyboard navigation resumes
  // on the same result instead of falling back to document.body.
  useLayoutEffect(() => {
    const resultsElement = resultsRef.current;
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!resultsElement) return;

    if (!visible) return;
    if (wasVisible) return;

    const retainedOffset = retainedScrollOffsetRef.current;
    resultsElement.scrollTop = retainedOffset;
    virtualizer.scrollToOffset(retainedOffset);

    let frame = 0;
    let cancelled = false;
    const restore = () => {
      if (cancelled) return;
      const focusedResultId = focusedResultIdRef.current;
      const row =
        focusedResultId === null
          ? null
          : resultsElement.querySelector<HTMLElement>(`[data-message-id="${focusedResultId}"]`);
      if (row) {
        row.focus({ preventScroll: true });
        return;
      }
      frame += 1;
      if (frame < 4) requestAnimationFrame(restore);
    };
    const raf = requestAnimationFrame(restore);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [visible, virtualizer]);

  // Resolve conversation name from contacts/channels
  const getConversationName = useCallback(
    (result: SearchResult): string => {
      if (result.type === 'CHAN') {
        const channel = channels.find(
          (c) => c.key.toUpperCase() === result.conversation_key.toUpperCase()
        );
        return channel?.name || result.conversation_key.slice(0, 8);
      }
      const contact = contacts.find(
        (c) => c.public_key.toLowerCase() === result.conversation_key.toLowerCase()
      );
      return contact?.name || result.conversation_key.slice(0, 12);
    },
    [contacts, channels]
  );

  const handleResultClick = useCallback(
    (result: SearchResult) => {
      onNavigateToMessage({
        id: result.id,
        type: result.type,
        conversation_key: result.conversation_key,
        conversation_name: getConversationName(result),
      });
    },
    [onNavigateToMessage, getConversationName]
  );

  // Focus on mount and when the scoped search hotkey targets an already-mounted view.
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusRequestVersion]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <h2 className="flex justify-between items-center px-4 py-2.5 border-b border-border font-semibold text-base">
        <Trans>Message Search</Trans>
      </h2>

      {/* Search input */}
      <div className="px-4 py-3 border-b border-border">
        <Input
          ref={inputRef}
          type="text"
          placeholder={t`Search all messages...`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            focusedResultIdRef.current = null;
          }}
          className="h-9 text-sm"
          aria-label={t`Search messages`}
        />
        <div className="min-h-6 pt-1 text-sm text-muted-foreground">
          {loading && !searchResultsQuery.isFetchingNextPage && (
            <LoadingIndicator label={t`Searching...`} />
          )}
          {loading && results.length > 0 && !searchResultsQuery.isFetchingNextPage && (
            <span className="ml-2">
              <Trans>Showing previous results while refreshing.</Trans>
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div
        ref={resultsRef}
        className="flex-1 overflow-y-auto [contain:layout_paint]"
        onScroll={(event) => {
          if (visible) retainedScrollOffsetRef.current = event.currentTarget.scrollTop;
        }}
      >
        {!committedQuery && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            <p>
              <Trans>Type to search across all messages</Trans>
            </p>
            <p className="mt-2 text-xs">
              <Trans>
                Tip: use <code>user:</code> or <code>channel:</code> for keys or names, and wrap
                names with spaces in them in quotes.
              </Trans>
            </p>
            <p className="mt-2 text-xs">
              <Trans>
                Warning: User-key linkage for group messages is best-effort and based on correlation
                at advertise time. It does not account for multiple users with the same name, and
                should be considered unreliable.
              </Trans>
            </p>
          </div>
        )}

        {committedQuery && results.length === 0 && !loading && !initialError && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            <Trans>No messages found for &ldquo;{committedQuery}&rdquo;</Trans>
          </div>
        )}

        {initialError && (
          <div className="space-y-3 p-8 text-center" role="alert">
            <p className="text-sm text-destructive">
              <Trans>Search failed. Check your connection and retry.</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={() => void searchResultsQuery.refetch()}>
              <Trans>Retry search</Trans>
            </Button>
          </div>
        )}

        {results.length > 0 && (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
            aria-label={t`Message search results`}
            data-virtual-viewport="search-results"
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const result = results[virtualRow.index];
              if (!result) return null;
              const convName = getConversationName(result);
              const typeBadge = result.type === 'CHAN' ? t`Channel` : t`DM`;

              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-virtual-row={String(virtualRow.key)}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <a
                    href={`${result.type === 'CHAN' ? '/channel' : '/contact'}/${encodeURIComponent(result.conversation_key)}?message=${result.id}`}
                    className="block px-4 py-3 border-b border-border/50 cursor-pointer hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    data-message-id={result.id}
                    onFocus={() => {
                      focusedResultIdRef.current = result.id;
                    }}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      ) {
                        return;
                      }
                      event.preventDefault();
                      handleResultClick(result);
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={cn(
                          'text-[0.625rem] font-medium px-1.5 py-0.5 rounded',
                          result.type === 'CHAN'
                            ? 'bg-primary/20 text-primary'
                            : 'bg-secondary text-secondary-foreground'
                        )}
                      >
                        {typeBadge}
                      </span>
                      <span className="text-xs font-medium text-foreground truncate">
                        {convName}
                      </span>
                      <span className="text-[0.6875rem] text-muted-foreground ml-auto flex-shrink-0">
                        {formatTime(result.received_at)}
                      </span>
                    </div>
                    <div className="text-[0.8125rem] text-foreground/80 line-clamp-2 break-words">
                      {result.sender_name && !result.outgoing && (
                        <span className="text-muted-foreground">{result.sender_name}: </span>
                      )}
                      {result.outgoing && (
                        <span className="text-muted-foreground">
                          <Trans>You: </Trans>
                        </span>
                      )}
                      {highlightMatch(
                        result.sender_name && result.text.startsWith(`${result.sender_name}: `)
                          ? result.text.slice(result.sender_name.length + 2)
                          : result.text,
                        highlightQuery
                      )}
                    </div>
                  </a>
                </div>
              );
            })}
          </div>
        )}

        {searchResultsQuery.isFetchingNextPage && !paginationError && (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <LoadingIndicator label={t`Loading more...`} />
          </div>
        )}

        {paginationError && (
          <div className="space-y-2 p-4 text-center" role="alert">
            <p className="text-sm text-destructive">
              <Trans>More results could not be loaded. Your existing results are unchanged.</Trans>
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void searchResultsQuery.fetchNextPage()}
            >
              <Trans>Retry loading more</Trans>
            </Button>
          </div>
        )}

        {searchResultsQuery.hasNextPage && !loading && !paginationError && (
          <div className="p-4 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void searchResultsQuery.fetchNextPage()}
            >
              <Trans>Load more results</Trans>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
