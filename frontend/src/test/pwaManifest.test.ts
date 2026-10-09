import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface ManifestAsset {
  src: string;
  type: string;
}

interface DevelopmentManifest {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  icons: ManifestAsset[];
  screenshots: ManifestAsset[];
}

describe('development PWA manifest', () => {
  it('uses MESHRIK metadata and references existing public assets', () => {
    const publicDir = resolve(process.cwd(), 'public');
    const manifest = JSON.parse(
      readFileSync(resolve(publicDir, 'site.webmanifest'), 'utf8')
    ) as DevelopmentManifest;

    expect(manifest.name).toBe('MESHRIK for MeshCore');
    expect(manifest.short_name).toBe('MESHRIK');
    expect(manifest.id).toBe('./');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');

    for (const asset of [...manifest.icons, ...manifest.screenshots]) {
      expect(asset.type).toBe('image/png');
      expect(existsSync(resolve(publicDir, asset.src.replace(/^\.\//, '')))).toBe(true);
    }
  });

  it('uses the MESHRIK name for iOS home-screen shortcuts', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="MESHRIK" />');
    expect(indexHtml).not.toContain('content="MCTerm"');
  });
});
