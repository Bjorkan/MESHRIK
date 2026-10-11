import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: ({ location }) => {
    if (location.pathname === '/settings') {
      throw redirect({ to: '/settings/radio', replace: true });
    }
  },
});
