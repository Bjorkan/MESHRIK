import { queryOptions } from '@tanstack/react-query';

import { api } from './api';
import { fetchAllContacts } from './prefetch';
import { queryKeys } from './queryClient';

export const contactsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.contacts(),
    queryFn: ({ signal }) => fetchAllContacts(signal),
  });

export const channelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.channels(),
    queryFn: ({ signal }) => api.getChannels(signal),
  });
