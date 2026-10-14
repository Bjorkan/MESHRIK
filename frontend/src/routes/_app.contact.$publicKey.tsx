import { createFileRoute } from '@tanstack/react-router';

import { contactsQueryOptions } from '../entityQueries';
import { validateEntitySearch } from '../routing/entityRoutes';

export const Route = createFileRoute('/_app/contact/$publicKey')({
  validateSearch: (search) => validateEntitySearch(search),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(contactsQueryOptions()).catch(() => undefined),
});
