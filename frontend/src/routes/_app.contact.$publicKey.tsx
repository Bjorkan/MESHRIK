import { createFileRoute } from '@tanstack/react-router';

import { contactsQueryOptions } from '../entityQueries';

export const Route = createFileRoute('/_app/contact/$publicKey')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(contactsQueryOptions()).catch(() => undefined),
});
