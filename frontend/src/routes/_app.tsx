import { createFileRoute } from '@tanstack/react-router';

import { RoutedApp } from '../RoutedApp';

export const Route = createFileRoute('/_app')({
  component: RoutedApp,
});
