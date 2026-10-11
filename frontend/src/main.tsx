import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import './index.css';
import './themes.css';
import './styles.css';
import { getSavedTheme, applyTheme, initFollowOSListener } from './utils/theme';
import { applyFontScale, getSavedFontScale } from './utils/fontScale';
import { PushSubscriptionProvider } from './contexts/PushSubscriptionContext';
import { router } from './router';
import { registerServiceWorker } from './serviceWorkerRegistration';

// Apply saved theme before first render
applyTheme(getSavedTheme());
// Re-apply when the OS color-scheme preference changes, if on "Follow OS".
initFollowOSListener();
applyFontScale(getSavedFontScale());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PushSubscriptionProvider>
      <RouterProvider router={router} />
    </PushSubscriptionProvider>
  </StrictMode>
);

// Register service worker for Web Push (requires secure context)
registerServiceWorker();
