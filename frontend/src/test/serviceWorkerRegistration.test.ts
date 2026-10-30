import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from '../serviceWorkerRegistration';

describe('registerServiceWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelector('base')?.remove();
    window.history.replaceState(null, '', '/');
  });

  it('registers the root service worker from a nested pathname', () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    });
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    window.history.replaceState(null, '', '/channel/example');

    registerServiceWorker();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });
  it('never registers a worker on the shared Home Assistant origin', () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    const base = document.createElement('base');
    base.href = '/api/hassio_ingress/secret-session/';
    document.head.prepend(base);

    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('scopes PWA registration to a non-HA reverse proxy subpath', () => {
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    const base = document.createElement('base');
    base.href = '/meshrik/';
    document.head.prepend(base);

    registerServiceWorker();
    expect(register).toHaveBeenCalledWith('/meshrik/sw.js', { scope: '/meshrik/' });
  });
});
