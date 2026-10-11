import { createFileRoute } from '@tanstack/react-router';

import { validateMapSearch } from '../routing/toolRoutes';

export const Route = createFileRoute('/_app/map')({
  validateSearch: (search) => validateMapSearch(search),
});
