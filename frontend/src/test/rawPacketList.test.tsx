import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RawPacketList } from '../components/RawPacketList';
import type { RawPacket } from '../types';

function createPacket(overrides: Partial<RawPacket> = {}): RawPacket {
  return {
    id: 1,
    timestamp: 1700000000,
    data: '000000000000',
    payload_type: 'REQ',
    snr: null,
    rssi: null,
    decrypted: false,
    decrypted_info: null,
    ...overrides,
  };
}

describe('RawPacketList', () => {
  it('renders TF badge for transport-flood packets', () => {
    render(<RawPacketList packets={[createPacket()]} />);

    expect(screen.getByText('TF')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes packet cards clickable only when an inspector handler is provided', () => {
    const packet = createPacket({ id: 9, observation_id: 22 });
    const onPacketClick = vi.fn();

    render(<RawPacketList packets={[packet]} onPacketClick={onPacketClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onPacketClick).toHaveBeenCalledWith(packet);
  });

  it('sticks to the bottom on new packets when autoScroll is on, and holds when off', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 500,
    });
    try {
      const { container, rerender } = render(
        <RawPacketList packets={[createPacket({ id: 1 })]} autoScroll />
      );
      const list = container.querySelector('.overflow-y-auto') as HTMLElement;

      rerender(
        <RawPacketList packets={[createPacket({ id: 1 }), createPacket({ id: 2 })]} autoScroll />
      );
      expect(list.scrollTop).toBe(500);

      // Pause autoscroll, simulate the user scrolling up, then receive a packet.
      list.scrollTop = 0;
      rerender(
        <RawPacketList
          packets={[createPacket({ id: 1 }), createPacket({ id: 2 }), createPacket({ id: 3 })]}
          autoScroll={false}
        />
      );
      expect(list.scrollTop).toBe(0);
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('keeps the mounted packet window bounded at 100, 1,000, and 5,000 rows', () => {
    const packets = Array.from({ length: 5_100 }, (_, index) =>
      createPacket({
        id: index + 1,
        observation_id: index + 1,
        timestamp: 1_700_000_000 + index,
      })
    );
    const { container, rerender } = render(
      <RawPacketList packets={packets.slice(0, 100)} autoScroll={false} />
    );
    const mountedRows = () => container.querySelectorAll('[data-index]').length;

    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThan(40);

    rerender(<RawPacketList packets={packets.slice(0, 1_000)} autoScroll={false} />);
    expect(mountedRows()).toBeLessThan(40);

    rerender(<RawPacketList packets={packets.slice(0, 5_000)} autoScroll={false} />);
    expect(mountedRows()).toBeLessThan(40);

    const list = container.querySelector('.overflow-y-auto') as HTMLElement;
    list.scrollTop = 120;
    rerender(<RawPacketList packets={packets} autoScroll={false} />);
    expect(mountedRows()).toBeLessThan(40);
    expect(list.scrollTop).toBe(120);
  });
});
