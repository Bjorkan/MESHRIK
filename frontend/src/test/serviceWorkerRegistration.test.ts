import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from '../serviceWorkerRegistration';

describe('registerServiceWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    expect(register).toHaveBeenCalledWith('/sw.js');
  });
});
