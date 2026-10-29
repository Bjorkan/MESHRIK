import { appBasePath, appUrl, ingressEmbedding } from './basePath';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  // Ingress shares Home Assistant's origin; installing a service worker there
  // would claim/subscribe on HA's origin instead of a standalone MESHRIK app.
  if (ingressEmbedding()) return;

  navigator.serviceWorker
    .register(appUrl('sw.js'), { scope: appBasePath() })
    .catch((err: unknown) => {
      console.warn('Service worker registration failed:', err);
    });
}
