import { createFileRoute } from '@tanstack/react-router';

import { channelsQueryOptions } from '../entityQueries';
import { validateEntitySearch } from '../routing/entityRoutes';

export const Route = createFileRoute('/_app/channel/$channelId')({
  validateSearch: (search) => validateEntitySearch(search),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(channelsQueryOptions()).catch(() => undefined),
});
