import { useEffect } from 'react';
import { useForm, useStore } from '@tanstack/react-form';

import {
  UNSCOPED_OVERRIDE_MARKER,
  isUnscopedMarker,
  stripRegionScopePrefix,
} from '../utils/regionScope';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface ChannelFloodScopeOverrideModalProps {
  open: boolean;
  onClose: () => void;
  roomName: string;
  currentOverride: string | null;
  onSetOverride: (value: string) => Promise<void>;
}

export function ChannelFloodScopeOverrideModal({
  open,
  onClose,
  roomName,
  currentOverride,
  onSetOverride,
}: ChannelFloodScopeOverrideModalProps) {
  const form = useForm({
    defaultValues: { region: '', pendingOverride: null as string | null, serverError: '' },
    onSubmit: async ({ value }) => {
      if (value.pendingOverride === null) return;
      form.setFieldValue('serverError', '');
      try {
        await onSetOverride(value.pendingOverride);
        form.reset();
        onClose();
      } catch (error) {
        form.setFieldValue(
          'serverError',
          error instanceof Error ? error.message : 'Failed to save regional override'
        );
      }
    },
  });
  const region = useStore(form.store, (state) => state.values.region);
  const serverError = useStore(form.store, (state) => state.values.serverError);
  const saving = useStore(form.store, (state) => state.isSubmitting);

  useEffect(() => {
    if (!open) {
      return;
    }
    // The unscoped marker isn't a region name, so start the input blank for it.
    form.reset();
    form.setFieldValue(
      'region',
      isUnscopedMarker(currentOverride) ? '' : stripRegionScopePrefix(currentOverride)
    );
  }, [currentOverride, form, open]);

  const trimmedRegion = region.trim();

  const submitOverride = (value: string) => {
    form.setFieldValue('pendingOverride', value);
    void form.handleSubmit();
  };

  const currentOverrideLabel = isUnscopedMarker(currentOverride)
    ? 'unscoped (plain flood)'
    : currentOverride
      ? stripRegionScopePrefix(currentOverride)
      : 'inherit global setting';

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !saving && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Regional Override</DialogTitle>
          <DialogDescription>
            Channel-level regional routing temporarily changes the radio flood scope before send and
            restores it after. This can noticeably slow channel sends. Choose one of three modes
            below: scope to a region, force unscoped (plain flood, ignoring your global region), or
            inherit the global setting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
            <div className="break-words font-medium">{roomName}</div>
            <div className="mt-1 text-muted-foreground">
              Current setting: {currentOverrideLabel}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="channel-region-input">Region</Label>
            <Input
              id="channel-region-input"
              value={region}
              onChange={(event) => {
                form.setFieldValue('region', event.target.value);
                form.setFieldValue('serverError', '');
              }}
              placeholder="Esperance"
              autoFocus
            />
          </div>
        </div>

        {serverError && (
          <p className="text-sm text-destructive" role="alert">
            {serverError}
          </p>
        )}

        <DialogFooter className="gap-2 sm:block sm:space-x-0">
          <div className="space-y-2">
            <Button
              type="button"
              className="w-full"
              disabled={trimmedRegion.length === 0 || saving}
              onClick={() => submitOverride(trimmedRegion)}
            >
              {saving ? 'Saving...' : 'Save regional scope'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={saving}
              onClick={() => submitOverride(UNSCOPED_OVERRIDE_MARKER)}
            >
              Always send unscoped
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={saving}
              onClick={() => submitOverride('')}
            >
              Use global region setting
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
