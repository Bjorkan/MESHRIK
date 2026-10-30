/** The server inserts a <base> before any script for root and Ingress pages.
 * All URL consumers use this single source so deep links cannot change
 * where the frontend contacts the API or loads static resources.
 */
function appBaseUrl(): string {
  // Built pages always include <base>. Default to the origin root in tests and
  // callers without an HTML shell, rather than interpreting nested routes as base.
  return document.querySelector('base')?.href ?? `${window.location.origin}/`;
}

export function appBasePath(): string {
  return new URL('.', appBaseUrl()).pathname;
}

export function appUrl(path: string): string {
  // Callers pass app-relative routes/assets, never origin-absolute paths.
  const url = new URL(path.replace(/^[/]+/, ''), appBaseUrl());
  return url.pathname + url.search + url.hash;
}

export function ingressEmbedding(): boolean {
  return /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(appBasePath());
}
