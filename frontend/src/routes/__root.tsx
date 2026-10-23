import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';

import type { AppRouterContext } from '../router';

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  useLingui();

  return <Outlet />;
}

export function NotFoundPage() {
  useLingui();

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold">
          <Trans>Page not found</Trans>
        </h1>
        <p className="text-sm text-muted-foreground">
          <Trans>The requested MESHRIK page does not exist.</Trans>
        </p>
        <Link to="/" className="inline-flex text-sm text-primary hover:underline">
          <Trans>Return to MESHRIK</Trans>
        </Link>
      </div>
    </main>
  );
}
