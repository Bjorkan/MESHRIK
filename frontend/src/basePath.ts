/** The server inserts a <base> before any script for root and Ingress pages.
 * All URL consumers use this single source so deep links cannot change
 * where the frontend contacts the API or loads static resources.
 */
export function appBasePath(): string {
  return new URL('.', document.baseURI).pathname;
}

export function appUrl(path: string): string {
  // Callers pass app-relative routes/assets, never origin-absolute paths.
  return new URL(path.replace(/^\/+/, ''), document.baseURI).pathname;
}

export function ingressEmbedding(): boolean {
  return /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(appBasePath());
}
