import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';

import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Label } from './ui/label';

const PATH_HASH_MODE_LABELS: Record<number, string> = {
  0: '1-byte',
  1: '2-byte',
  2: '3-byte',
};

interface ChannelPathHashModeOverrideModalProps {
  open: boolean;
  onClose: () => void;
  channelName: string;
  currentOverride: number | null;
  radioDefault: number;
  onSetOverride: (value: number | null) => Promise<void>;
}

export function ChannelPathHashModeOverrideModal({
  open,
  onClose,
  channelName,
  currentOverride,
  radioDefault,
  onSetOverride,
}: ChannelPathHashModeOverrideModalProps) {
  useLingui();

  const form = useForm({
    defaultValues: {
      selected: null as number | null,
      submitRequested: false,
      serverError: '',
    },
    onSubmit: async ({ value }) => {
      if (!value.submitRequested) return;
      form.setFieldValue('serverError', '');
      try {
        await onSetOverride(value.selected);
        form.reset();
        onClose();
      } catch (error) {
        form.setFieldValue(
          'serverError',
          error instanceof Error ? error.message : 'Failed to save path hop width override'
        );
      }
    },
  });
  const selected = useStore(form.store, (state) => state.values.selected);
  const serverError = useStore(form.store, (state) => state.values.serverError);
  const saving = useStore(form.store, (state) => state.isSubmitting);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) {
      form.reset();
      form.setFieldValue('selected', currentOverride);
    }
  }, [currentOverride, form, open]);

  const radioDefaultLabel = PATH_HASH_MODE_LABELS[radioDefault] ?? `${radioDefault}`;

  const options: { value: number | null; label: string; description: string }[] = [
    {
      value: null,
      get label() {
        return t`Radio default (${radioDefaultLabel})`;
      },
      get description() {
        return t`Use the radio-wide path hash mode setting`;
      },
    },
    {
      value: 0,
      get label() {
        return t`1-byte hop identifiers`;
      },
      get description() {
        return t`Least repeater disambiguation, up to 63 hops`;
      },
    },
    {
      value: 1,
      get label() {
        return t`2-byte hop identifiers`;
      },
      get description() {
        return t`Better repeater disambiguation, up to 32 hops`;
      },
    },
    {
      value: 2,
      get label() {
        return t`3-byte hop identifiers`;
      },
      get description() {
        return t`Best repeater disambiguation, up to 21 hops`;
      },
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !saving && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Path Hop Width Override</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Override the path hash mode for this channel. Wider hop identifiers improve repeater
              disambiguation but extend send time and will prevent users on old (&lt;1.14) firmware
              from receiving the message.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
            <div className="break-words font-medium">{channelName}</div>
            <div className="mt-1 text-muted-foreground">
              <Trans>
                Current override:{' '}
                {currentOverride != null
                  ? (PATH_HASH_MODE_LABELS[currentOverride] ?? `mode ${currentOverride}`)
                  : `none (using radio default: ${radioDefaultLabel})`}
              </Trans>
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              <Trans>Hop width for this channel</Trans>
            </Label>
            <div
              className="space-y-1.5"
              role="radiogroup"
              aria-label={t`Hop width for this channel`}
            >
              {options.map((opt, index) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  role="radio"
                  aria-checked={selected === opt.value}
                  tabIndex={selected === opt.value ? 0 : -1}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  disabled={saving}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    selected === opt.value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:bg-accent'
                  }`}
                  onClick={() => {
                    form.setFieldValue('selected', opt.value);
                    form.setFieldValue('serverError', '');
                  }}
                  onKeyDown={(event) => {
                    let nextIndex: number | null = null;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                      nextIndex = (index + 1) % options.length;
                    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                      nextIndex = (index - 1 + options.length) % options.length;
                    } else if (event.key === 'Home') {
                      nextIndex = 0;
                    } else if (event.key === 'End') {
                      nextIndex = options.length - 1;
                    }
                    if (nextIndex == null) return;
                    event.preventDefault();
                    const next = options[nextIndex];
                    form.setFieldValue('selected', next.value);
                    form.setFieldValue('serverError', '');
                    optionRefs.current[nextIndex]?.focus();
                  }}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.description}</div>
                </button>
              ))}
            </div>
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
              disabled={saving}
              onClick={() => {
                form.setFieldValue('submitRequested', true);
                void form.handleSubmit();
              }}
            >
              {saving ? t`Saving...` : t`Save hop width`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={saving}
              onClick={onClose}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
