import { StrictMode } from 'react';
import { I18nProvider } from '@lingui/react';
import { i18n, activateLanguage, getLanguagePreference, LANGUAGE_STORAGE_KEY } from './i18n';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { HotkeysProvider } from '@tanstack/react-hotkeys';
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

await activateLanguage(getLanguagePreference());
window.addEventListener('languagechange', () => {
  if (getLanguagePreference() === 'auto') void activateLanguage('auto');
});
window.addEventListener('storage', (event) => {
  if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
    void activateLanguage(getLanguagePreference());
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <HotkeysProvider
        defaultOptions={{
          hotkey: { conflictBehavior: 'error' },
          hotkeySequence: { conflictBehavior: 'error' },
        }}
      >
        <PushSubscriptionProvider>
          <RouterProvider router={router} />
        </PushSubscriptionProvider>
      </HotkeysProvider>
    </I18nProvider>
  </StrictMode>
);

// Register service worker for Web Push (requires secure context)
registerServiceWorker();
