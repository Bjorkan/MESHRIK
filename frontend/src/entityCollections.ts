import { createCollection, eq, useLiveQuery } from '@tanstack/react-db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from './api';
import { fetchAllContacts } from './prefetch';
import { queryKeys } from './queryClient';
import { CONTACT_TYPE_REPEATER, type Channel, type Contact } from './types';

const collectionsByClient = new WeakMap<QueryClient, ReturnType<typeof createEntityCollections>>();

function createEntityCollections(queryClient: QueryClient) {
  const contacts = createCollection(
    queryCollectionOptions<Contact>({
      queryClient,
      queryKey: queryKeys.contacts(),
      queryFn: ({ signal }) => fetchAllContacts(signal),
      getKey: (contact) => contact.public_key,
    })
  );
  const channels = createCollection(
    queryCollectionOptions<Channel>({
      queryClient,
      queryKey: queryKeys.channels(),
      queryFn: ({ signal }) => api.getChannels(signal),
      getKey: (channel) => channel.key,
    })
  );

  return { contacts, channels };
}

export function getEntityCollections(queryClient: QueryClient) {
  const existing = collectionsByClient.get(queryClient);
  if (existing) return existing;

  const collections = createEntityCollections(queryClient);
  collectionsByClient.set(queryClient, collections);
  return collections;
}

export function useEntityCollections() {
  return getEntityCollections(useQueryClient());
}

/**
 * Contacts and channels are the synchronized entity tables. Repeaters are a
 * typed live view over contacts because the backend represents them as
 * contact rows rather than exposing a second server snapshot.
 */
export function useLiveEntities() {
  const collections = useEntityCollections();
  const contacts = useLiveQuery({
    query: (query) => query.from({ contact: collections.contacts }),
  });
  const channels = useLiveQuery({
    query: (query) => query.from({ channel: collections.channels }),
  });
  const repeaters = useLiveQuery({
    query: (query) =>
      query
        .from({ contact: collections.contacts })
        .where(({ contact }) => eq(contact.type, CONTACT_TYPE_REPEATER)),
  });

  return { collections, contacts, channels, repeaters };
}
