import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '../components/ui/sonner';
import { copyTextWithFeedback } from '../utils/clipboard';

vi.mock('../components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('copyTextWithFeedback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('waits for clipboard confirmation before reporting success', async () => {
    let resolveWrite!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const result = copyTextWithFeedback('synthetic-key', 'Copied!');
    expect(toast.success).not.toHaveBeenCalled();
    resolveWrite();

    await expect(result).resolves.toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Copied!');
  });

  it('reports rejection without a false success or unhandled promise', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    await expect(copyTextWithFeedback('synthetic-key', 'Copied!')).resolves.toBe(false);

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Copy failed', {
      description: 'Clipboard access is unavailable or was denied',
    });
  });

  it('reports a missing clipboard API as a visible failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    await expect(copyTextWithFeedback('synthetic-key', 'Copied!')).resolves.toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Copy failed', {
      description: 'Clipboard access is unavailable or was denied',
    });
  });
});
