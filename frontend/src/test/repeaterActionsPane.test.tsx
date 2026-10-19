import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsPane } from '../components/repeater/RepeaterActionsPane';
import type { RepeaterPendingAction } from '../hooks/useRepeaterDashboard';

afterEach(cleanup);

const callbacks = () => ({
  onSendZeroHopAdvert: vi.fn(),
  onSendFloodAdvert: vi.fn(),
  onSyncClock: vi.fn(),
  onReboot: vi.fn(),
});

describe('repeater action feedback', () => {
  it.each<[RepeaterPendingAction, string]>([
    ['zero-hop-advert', 'Requesting zero-hop advert...'],
    ['flood-advert', 'Requesting flood advert...'],
    ['clock', 'Requesting clock sync...'],
    ['reboot', 'Requesting reboot...'],
    ['console', 'Waiting for console command...'],
  ])('identifies %s without triggering commands', (pendingAction, label) => {
    const handlers = callbacks();
    const { rerender } = render(
      <ActionsPane {...handlers} consoleLoading pendingAction={pendingAction} />
    );
    expect(screen.getByRole('status')).toHaveTextContent(label);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    for (const callback of Object.values(handlers)) expect(callback).not.toHaveBeenCalled();
    rerender(<ActionsPane {...handlers} consoleLoading={false} pendingAction={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeEnabled();
  });

  it('still requires explicit reboot confirmation', () => {
    const handlers = callbacks();
    render(<ActionsPane {...handlers} consoleLoading={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }));
    expect(handlers.onReboot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reboot' }));
    expect(handlers.onReboot).toHaveBeenCalledTimes(1);
  });
});
