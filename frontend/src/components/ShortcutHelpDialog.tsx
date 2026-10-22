import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { formatForDisplay, useHotkeyRegistrations } from '@tanstack/react-hotkeys';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

interface ShortcutHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutHelpEntry {
  id: string;
  binding: string;
  enabled: boolean;
  name: string;
  description?: string;
  group: string;
}

function displayHotkey(hotkey: Parameters<typeof formatForDisplay>[0]): string {
  return String(formatForDisplay(hotkey));
}

export function ShortcutHelpDialog({ open, onOpenChange }: ShortcutHelpDialogProps) {
  useLingui();

  const { hotkeys, sequences } = useHotkeyRegistrations();
  const entries: ShortcutHelpEntry[] = [
    ...hotkeys.flatMap((registration) => {
      const { meta } = registration.options;
      if (!meta?.name) return [];
      return [
        {
          id: registration.id,
          binding: displayHotkey(registration.hotkey),
          enabled: registration.options.enabled !== false,
          name: meta.name,
          description: meta.description,
          group: meta.group ?? 'Other',
        },
      ];
    }),
    ...sequences.flatMap((registration) => {
      const { meta } = registration.options;
      if (!meta?.name) return [];
      return [
        {
          id: registration.id,
          binding: registration.sequence.map(displayHotkey).join(' then '),
          enabled: registration.options.enabled !== false,
          name: meta.name,
          description: meta.description,
          group: meta.group ?? 'Other',
        },
      ];
    }),
  ].sort((left, right) =>
    left.group === right.group
      ? left.name.localeCompare(right.name)
      : left.group.localeCompare(right.group)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>
          <Trans>Keyboard shortcuts</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Active shortcuts follow the current route and open panels. Disabled shortcuts remain
            listed for discoverability.
          </Trans>
        </DialogDescription>
        <div className="space-y-2" aria-label={t`Keyboard shortcut registry`}>
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
            >
              <div className={entry.enabled ? undefined : `opacity-50`}>
                <div className="text-sm font-medium">{entry.name}</div>
                {entry.description && (
                  <div className="text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <kbd className="shrink-0 rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                {entry.binding}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
