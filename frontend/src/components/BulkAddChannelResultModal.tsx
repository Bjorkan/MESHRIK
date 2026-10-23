import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Link } from '@tanstack/react-router';

import type { BulkCreateHashtagChannelsResult } from '../types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface BulkAddChannelResultModalProps {
  open: boolean;
  result: BulkCreateHashtagChannelsResult | null;
  onClose: () => void;
}

export function BulkAddChannelResultModal({
  open,
  result,
  onClose,
}: BulkAddChannelResultModalProps) {
  useLingui();

  const createdChannels = result?.created_channels ?? [];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Bulk Add Complete</Trans>
          </DialogTitle>
          <DialogDescription>
            {result?.message ?? t`Review the newly added rooms below.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {result && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                <div className="text-[0.625rem] uppercase tracking-wider font-medium text-muted-foreground">
                  <Trans>Created</Trans>
                </div>
                <div className="mt-1 font-medium">{createdChannels.length}</div>
              </div>
              <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                <div className="text-[0.625rem] uppercase tracking-wider font-medium text-muted-foreground">
                  <Trans>Already Present</Trans>
                </div>
                <div className="mt-1 font-medium">{result.existing_count}</div>
              </div>
            </div>
          )}

          {createdChannels.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                <Trans>Ctrl+click any room to open it in a new tab.</Trans>
              </p>
              <div className="max-h-64 overflow-y-auto rounded-md border border-border/70">
                <ul className="divide-y divide-border/70">
                  {createdChannels.map((channel) => (
                    <li key={channel.key}>
                      <Link
                        to="/channel/$channelId"
                        params={{ channelId: channel.key }}
                        className="block px-3 py-2 text-sm text-primary hover:bg-accent hover:text-primary"
                      >
                        {channel.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>No new channels were added.</Trans>
            </p>
          )}

          {result && result.invalid_names.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              <Trans>Ignored invalid channel names: {result.invalid_names.join(', ')}</Trans>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
