import { createFileRoute } from '@tanstack/react-router';

import { validateMessageSearch } from '../routing/toolRoutes';

export const Route = createFileRoute('/_app/search')({
  validateSearch: (search) => validateMessageSearch(search),
});
