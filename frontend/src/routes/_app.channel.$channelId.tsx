import { createFileRoute } from '@tanstack/react-router';

import { channelsQueryOptions } from '../entityQueries';

export const Route = createFileRoute('/_app/channel/$channelId')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(channelsQueryOptions()).catch(() => undefined),
});
