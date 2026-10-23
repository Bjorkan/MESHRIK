import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { I18nProvider } from '@lingui/react';
import { i18n } from '../i18n';
import { vi, beforeEach } from 'vitest';

// Exercise the real provider/catalog, while keeping pre-existing English assertions deterministic.
vi.mock('@testing-library/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@testing-library/react')>();
  const withLanguage = (Wrapper?: React.ComponentType<{ children: React.ReactNode }>) =>
    function TestLanguageProvider({ children }: { children: React.ReactNode }) {
      return createElement(
        I18nProvider,
        { i18n },
        Wrapper ? createElement(Wrapper, null, children) : children
      );
    };
  return {
    ...actual,
    render: (
      ui: Parameters<typeof actual.render>[0],
      options: Parameters<typeof actual.render>[1] = {}
    ) => actual.render(ui, { ...options, wrapper: withLanguage(options.wrapper) }),
    renderHook: (
      callback: (props: unknown) => unknown,
      options: { wrapper?: React.ComponentType<{ children: React.ReactNode }> } = {}
    ) => actual.renderHook(callback, { ...options, wrapper: withLanguage(options.wrapper) }),
  };
});
beforeEach(() => {
  if (i18n.locale !== 'en') i18n.activate('en');
});

// Node 26 exposes an experimental global `localStorage` that evaluates to
// undefined unless the process is started with --localstorage-file. Define a
// deterministic browser-compatible store so JSDOM tests do not inherit that
// host-specific global.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(String(key), String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserver;

// Several components call matchMedia at import time for responsive detection.
// Use a configurable descriptor so individual tests can override the stub.
if (typeof globalThis.matchMedia === 'undefined') {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
