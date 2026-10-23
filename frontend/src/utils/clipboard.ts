import { t } from '@lingui/core/macro';
import { toast } from '../components/ui/sonner';

/** Copy user-requested text and report only the browser-confirmed outcome. */
export async function copyTextWithFeedback(text: string, successMessage: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error(t`Clipboard API unavailable`);
    }
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error(t`Copy failed`, {
      get description() {
        return t`Clipboard access is unavailable or was denied`;
      },
    });
    return false;
  }
}
