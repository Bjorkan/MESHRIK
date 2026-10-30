import { afterEach, describe, expect, it } from 'vitest';
import { appBasePath, appUrl, ingressEmbedding } from '../basePath';

describe('per-request application base path', () => {
  afterEach(() => document.querySelector('base')?.remove());

  it('uses root paths independently of nested browser history routes', () => {
    expect(appBasePath()).toBe('/');
    expect(appUrl('api/contacts?limit=10')).toBe('/api/contacts?limit=10');
    expect(appUrl('favicon.svg')).toBe('/favicon.svg');
    expect(ingressEmbedding()).toBe(false);
  });

  it('uses the ingress session path for all resources and routes', () => {
    const base = document.createElement('base');
    base.href = '/api/hassio_ingress/abc123/';
    document.head.prepend(base);

    expect(appBasePath()).toBe('/api/hassio_ingress/abc123/');
    expect(appUrl('api/contacts?limit=10')).toBe(
      '/api/hassio_ingress/abc123/api/contacts?limit=10'
    );
    expect(appUrl('/api/ws')).toBe('/api/hassio_ingress/abc123/api/ws');
    expect(appUrl('favicon.svg')).toBe('/api/hassio_ingress/abc123/favicon.svg');
    expect(ingressEmbedding()).toBe(true);
  });

  it('supports generic application subpath deployments', () => {
    const base = document.createElement('base');
    base.href = '/meshrik/';
    document.head.prepend(base);
    expect(appUrl('api/health')).toBe('/meshrik/api/health');
    expect(ingressEmbedding()).toBe(false);
  });
});
