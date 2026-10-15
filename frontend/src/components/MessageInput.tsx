import {
  useCallback,
  useImperativeHandle,
  forwardRef,
  useRef,
  useEffect,
  useMemo,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { Button } from './ui/button';
import { toast } from './ui/sonner';
import { cn } from '@/lib/utils';
import {
  getTextReplaceEnabled,
  getTextReplaceMapJson,
  applyTextReplacements,
} from '../utils/textReplace';

// MeshCore message size limits (empirically determined from LoRa packet constraints)
// Direct delivery allows ~156 bytes; multi-hop requires buffer for path growth.
// Channels include "sender: " prefix in the encrypted payload.
// All limits are in bytes (UTF-8), not characters, since LoRa packets are byte-constrained.
const DM_HARD_LIMIT = 156; // Max bytes for direct delivery
const DM_WARNING_THRESHOLD = 140; // Conservative for multi-hop
const CHANNEL_HARD_LIMIT = 156; // Base byte limit before sender overhead
const CHANNEL_WARNING_THRESHOLD = 120; // Conservative for multi-hop
const CHANNEL_DANGER_BUFFER = 8; // Red zone starts this many bytes before hard limit

const textEncoder = new TextEncoder();
const RADIO_NO_RESPONSE_SNIPPET = 'no response was heard back';
/** Get UTF-8 byte length of a string (LoRa packets are byte-constrained, not character-constrained). */
function byteLen(s: string): number {
  return textEncoder.encode(s).length;
}

interface MessageInputProps {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  placeholder?: string;
  /** Conversation type for character limit calculation */
  conversationType?: 'contact' | 'channel' | 'raw';
  /** Sender name (radio name) for channel message limit calculation */
  senderName?: string;
}

type LimitState = 'normal' | 'warning' | 'danger' | 'error';

export interface MessageInputHandle {
  appendText: (text: string) => void;
  focus: () => void;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  { onSend, disabled, placeholder, conversationType, senderName },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: async ({ value }) => {
      // Preserve the authored payload byte-for-byte. Whitespace is meaningful
      // in chat text; only an entirely whitespace-only draft is not sendable.
      const payloadText = value.text;
      if (!payloadText.trim() || disabled) return;

      try {
        await onSend(payloadText);
        form.reset();
      } catch (err) {
        console.error('Failed to send message:', err);
        const description = err instanceof Error ? err.message : 'Check radio connection';
        const isRadioNoResponse =
          err instanceof Error && err.message.toLowerCase().includes(RADIO_NO_RESPONSE_SNIPPET);
        toast.error(isRadioNoResponse ? 'Radio did not confirm send' : 'Failed to send message', {
          description,
        });
        return;
      }
      // Refocus after React re-enables the textarea
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
  });
  const text = useStore(form.store, (state) => state.values.text);
  const sending = useStore(form.store, (state) => state.isSubmitting);

  /** Resize textarea to fit content, clamped between 1 row and ~6 rows. */
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Clamp: min 40px (≈1 row), max 160px (≈6 rows)
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  useImperativeHandle(ref, () => ({
    appendText: (appendedText: string) => {
      form.setFieldValue('text', (previous) => previous + appendedText);
      textareaRef.current?.focus();
    },
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  // Re-measure height whenever text changes (covers programmatic updates like appendText)
  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  // Calculate character limits based on conversation type
  const limits = useMemo(() => {
    if (conversationType === 'contact') {
      return {
        warningAt: DM_WARNING_THRESHOLD,
        dangerAt: DM_HARD_LIMIT, // Same as hard limit for DMs (no intermediate red zone)
        hardLimit: DM_HARD_LIMIT,
      };
    } else if (conversationType === 'channel') {
      // Channel hard limit = 156 bytes - senderName bytes - 2 (for ": " separator)
      const nameByteLen = senderName ? byteLen(senderName) : 10;
      const hardLimit = Math.max(1, CHANNEL_HARD_LIMIT - nameByteLen - 2);
      return {
        warningAt: CHANNEL_WARNING_THRESHOLD,
        dangerAt: Math.max(1, hardLimit - CHANNEL_DANGER_BUFFER),
        hardLimit,
      };
    }
    return null; // Raw/other - no limits
  }, [conversationType, senderName]);

  // UTF-8 byte length of the exact payload passed to onSend.
  const textByteLen = useMemo(() => byteLen(text), [text]);

  // Determine current limit state
  const { limitState, warningMessage } = useMemo((): {
    limitState: LimitState;
    warningMessage: string | null;
  } => {
    if (!limits) return { limitState: 'normal', warningMessage: null };

    if (textByteLen >= limits.hardLimit) {
      return { limitState: 'error', warningMessage: 'likely truncated by radio' };
    }
    if (textByteLen >= limits.dangerAt) {
      return { limitState: 'danger', warningMessage: 'may impact multi-repeater hop delivery' };
    }
    if (textByteLen >= limits.warningAt) {
      return { limitState: 'warning', warningMessage: 'may impact multi-repeater hop delivery' };
    }
    return { limitState: 'normal', warningMessage: null };
  }, [textByteLen, limits]);

  const remaining = limits ? limits.hardLimit - textByteLen : 0;

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (sending || disabled || limitState === 'error') return;
      void form.handleSubmit();
    },
    [disabled, form, limitState, sending]
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const input = e.target;
      const raw = input.value;
      // Skip replacement during IME / dead-key composition to avoid garbling interim input
      if (!e.nativeEvent || (e.nativeEvent as InputEvent).isComposing) {
        form.setFieldValue('text', raw);
        return;
      }
      if (getTextReplaceEnabled()) {
        const result = applyTextReplacements(
          raw,
          input.selectionStart ?? raw.length,
          getTextReplaceMapJson()
        );
        if (result) {
          form.setFieldValue('text', result.text);
          // Schedule cursor restore after React flushes the new value
          const pos = result.cursor;
          requestAnimationFrame(() => input.setSelectionRange(pos, pos));
          return;
        }
      }
      form.setFieldValue('text', raw);
    },
    [form]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
      // Shift+Enter falls through naturally and inserts a newline
    },
    [handleSubmit]
  );

  const canSubmit = text.trim().length > 0 && limitState !== 'error';

  // Show counter for messages (not raw).
  // Desktop: always visible. Mobile: show once the encoded payload reaches
  // 100 bytes, so emoji/CJK drafts get the same early warning as ASCII.
  const showCharCounter = limits !== null;
  const showMobileCounterValue = textByteLen >= 100;

  return (
    <form
      className="message-input-shell px-4 py-2.5 border-t border-border flex flex-col gap-1"
      onSubmit={handleSubmit}
      autoComplete="off"
    >
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          name="chat-message-input"
          aria-label={placeholder || 'Type a message'}
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          rows={1}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Type a message...'}
          aria-invalid={limitState === 'error'}
          disabled={disabled || sending}
          className={cn(
            'flex-1 min-w-0 resize-none overflow-y-auto',
            'rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background',
            'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50 md:text-sm'
          )}
          style={{ minHeight: '40px', maxHeight: '160px' }}
        />
        <Button
          type="submit"
          disabled={disabled || sending || !canSubmit}
          className="flex-shrink-0"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
      {showCharCounter && (
        <>
          <div className="hidden sm:flex items-center justify-end gap-2 text-xs">
            <span
              className={cn(
                'tabular-nums',
                limitState === 'error' || limitState === 'danger'
                  ? 'text-destructive font-medium'
                  : limitState === 'warning'
                    ? 'text-warning'
                    : 'text-muted-foreground'
              )}
            >
              {textByteLen}/{limits!.hardLimit}
              {remaining < 0 && ` (${remaining})`}
            </span>
            {warningMessage && (
              <span className={cn(limitState === 'error' ? 'text-destructive' : 'text-warning')}>
                — {warningMessage}
              </span>
            )}
          </div>

          {(showMobileCounterValue || warningMessage) && (
            <div
              className="flex sm:hidden items-center justify-end gap-2 text-xs"
              data-testid="mobile-byte-counter"
            >
              {showMobileCounterValue && (
                <span
                  className={cn(
                    'tabular-nums',
                    limitState === 'error' || limitState === 'danger'
                      ? 'text-destructive font-medium'
                      : limitState === 'warning'
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  )}
                >
                  {textByteLen}/{limits!.hardLimit}
                  {remaining < 0 && ` (${remaining})`}
                </span>
              )}
              {warningMessage && (
                <span className={cn(limitState === 'error' ? 'text-destructive' : 'text-warning')}>
                  — {warningMessage}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </form>
  );
});
