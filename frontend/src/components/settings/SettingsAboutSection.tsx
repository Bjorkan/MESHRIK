import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { HealthStatus } from '../../types';
import { Separator } from '../ui/separator';

const GITHUB_URL = 'https://github.com/Bjorkan/MESHRIK';

export function SettingsAboutSection({
  health,
  className,
}: {
  health?: HealthStatus | null;
  className?: string;
}) {
  useLingui();

  const version = health?.app_info?.version ?? 'unknown';
  const commit = health?.app_info?.commit_hash;

  return (
    <div className={className}>
      <div className="space-y-6">
        {/* Version */}
        <div className="text-center space-y-1">
          <h3 className="text-lg font-semibold">
            <Trans>MESHRIK for MeshCore</Trans>
          </h3>
          <div className="text-sm text-muted-foreground">
            <Trans>v</Trans>
            {version}
            {commit ? (
              <>
                <span className="mx-1.5">·</span>
                <span className="font-mono text-xs" title={commit}>
                  {commit}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <Separator />

        {/* Author & License */}
        <div className="text-sm text-center space-y-2">
          <p>
            <Trans>
              MESHRIK is maintained by{' '}
              <a
                href="https://github.com/Bjorkan"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Bjorkan
              </a>
              . Originally created with love and open source by{' '}
              <a
                href="https://jacksbrain.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Jack Kingsman
              </a>
            </Trans>
          </p>
          <p>
            <Trans>
              Licensed under the{' '}
              <a
                href={`${GITHUB_URL}/blob/main/LICENSE.md`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                MIT License
              </a>
            </Trans>
          </p>
          <p>
            <Trans>
              This code is free and ad-free. If you appreciate the original work,{' '}
              <a
                href="https://ko-fi.com/jackkingsman"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                buy me a coffee!
              </a>
            </Trans>
          </p>
        </div>

        <Separator />

        {/* Links */}
        <div className="flex justify-center gap-4 text-sm">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            <Trans>GitHub</Trans>
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            <Trans>Report a Bug</Trans>
          </a>
          <a
            href={`${GITHUB_URL}/blob/main/CHANGELOG.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            <Trans>Changelog</Trans>
          </a>
        </div>

        <Separator />

        {/* Acknowledgements */}
        <div className="text-sm text-center text-muted-foreground space-y-2">
          <p>
            <Trans>
              With great appreciation to those who have made the tools upon which this is built:
            </Trans>
          </p>
          <p>
            <a
              href="https://github.com/meshcore-dev/MeshCore"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              <Trans>MeshCore</Trans>
            </a>
            <span className="mx-1.5">·</span>
            <a
              href="https://github.com/meshcore-dev/meshcore_py"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              <Trans>meshcore_py</Trans>
            </a>
          </p>
        </div>

        <Separator />

        <div className="text-center">
          <a
            href="/api/debug"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-primary hover:underline"
          >
            <Trans>Open debug support snapshot</Trans>
          </a>
        </div>
      </div>
    </div>
  );
}
