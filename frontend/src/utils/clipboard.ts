import { toast } from '../components/ui/sonner';

const CLIPBOARD_ERROR_DESCRIPTION = 'Clipboard access is unavailable or was denied';

/** Copy user-requested text and report only the browser-confirmed outcome. */
export async function copyTextWithFeedback(text: string, successMessage: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error('Copy failed', { description: CLIPBOARD_ERROR_DESCRIPTION });
    return false;
  }
}
