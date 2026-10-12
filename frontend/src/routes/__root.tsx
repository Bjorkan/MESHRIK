import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  return <Outlet />;
}

export function NotFoundPage() {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">The requested MESHRIK page does not exist.</p>
        <Link to="/" className="inline-flex text-sm text-primary hover:underline">
          Return to MESHRIK
        </Link>
      </div>
    </main>
  );
}
