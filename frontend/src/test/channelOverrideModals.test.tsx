import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChannelFloodScopeOverrideModal } from '../components/ChannelFloodScopeOverrideModal';
import { ChannelPathHashModeOverrideModal } from '../components/ChannelPathHashModeOverrideModal';
import { UNSCOPED_OVERRIDE_MARKER } from '../utils/regionScope';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('channel override modals', () => {
  it('waits for regional scope persistence and blocks duplicate submission', async () => {
    const save = deferred();
    const onSetOverride = vi.fn(() => save.promise);
    const onClose = vi.fn();
    render(
      <ChannelFloodScopeOverrideModal
        open
        onClose={onClose}
        roomName={'Very long synthetic channel '.repeat(4)}
        currentOverride={null}
        onSetOverride={onSetOverride}
      />
    );

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'North' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save regional scope' }));

    await waitFor(() => expect(onSetOverride).toHaveBeenCalledTimes(1));
    expect(onSetOverride).toHaveBeenCalledWith('North');
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    expect(onSetOverride).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    save.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps the regional draft and shows one inline error before retry', async () => {
    const onSetOverride = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Save unavailable'))
      .mockResolvedValueOnce();
    const onClose = vi.fn();
    render(
      <ChannelFloodScopeOverrideModal
        open
        onClose={onClose}
        roomName="Test channel"
        currentOverride={null}
        onSetOverride={onSetOverride}
      />
    );

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'South' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save regional scope' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByLabelText('Region')).toHaveValue('South');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save regional scope' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSetOverride).toHaveBeenNthCalledWith(2, 'South');
  });

  it('passes unscoped and global choices while Cancel commits nothing', async () => {
    const onSetUnscoped = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <ChannelFloodScopeOverrideModal
        open
        onClose={vi.fn()}
        roomName="Test channel"
        currentOverride={null}
        onSetOverride={onSetUnscoped}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Always send unscoped' }));
    await waitFor(() => expect(onSetUnscoped).toHaveBeenCalledWith(UNSCOPED_OVERRIDE_MARKER));
    unmount();

    const onSetGlobal = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ChannelFloodScopeOverrideModal
        open
        onClose={onClose}
        roomName="Test channel"
        currentOverride="#North"
        onSetOverride={onSetGlobal}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use global region setting' }));
    await waitFor(() => expect(onSetGlobal).toHaveBeenCalledWith(''));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSetGlobal).toHaveBeenCalledTimes(1);
  });

  it('exposes hop-width selection state and retains it after a failed save', async () => {
    const onSetOverride = vi
      .fn<(value: number | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Radio busy'))
      .mockResolvedValueOnce();
    const onClose = vi.fn();
    render(
      <ChannelPathHashModeOverrideModal
        open
        onClose={onClose}
        channelName={'Long channel '.repeat(8)}
        currentOverride={null}
        radioDefault={1}
        onSetOverride={onSetOverride}
      />
    );

    const threeByte = screen.getByRole('radio', { name: /3-byte hop identifiers/i });
    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
    fireEvent.click(threeByte);
    expect(threeByte).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save hop width' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Radio busy');
    expect(threeByte).toHaveAttribute('aria-checked', 'true');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save hop width' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSetOverride).toHaveBeenNthCalledWith(2, 2);
  });

  it('passes the radio-default hop width as null', async () => {
    const onSetOverride = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelPathHashModeOverrideModal
        open
        onClose={vi.fn()}
        channelName="Test channel"
        currentOverride={2}
        radioDefault={1}
        onSetOverride={onSetOverride}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Radio default/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save hop width' }));
    await waitFor(() => expect(onSetOverride).toHaveBeenCalledWith(null));
  });

  it('supports roving arrow-key focus across hop-width radios', () => {
    render(
      <ChannelPathHashModeOverrideModal
        open
        onClose={vi.fn()}
        channelName="Test channel"
        currentOverride={null}
        radioDefault={1}
        onSetOverride={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const radioDefault = screen.getByRole('radio', { name: /Radio default/i });
    const oneByte = screen.getByRole('radio', { name: /1-byte hop identifiers/i });
    expect(radioDefault).toHaveAttribute('tabindex', '0');
    expect(oneByte).toHaveAttribute('tabindex', '-1');

    radioDefault.focus();
    fireEvent.keyDown(radioDefault, { key: 'ArrowDown' });
    expect(oneByte).toHaveFocus();
    expect(oneByte).toHaveAttribute('aria-checked', 'true');
    expect(oneByte).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(oneByte, { key: 'End' });
    expect(screen.getByRole('radio', { name: /3-byte hop identifiers/i })).toHaveFocus();
  });
});
