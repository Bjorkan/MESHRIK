import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrackerPanel } from '../components/CrackerPanel';
import {
  getRawPackets,
  recordRawPacket,
  resetRawPacketStore,
  seedRawPacketStore,
} from '../stores/rawPacketStore';
import type { RawPacket } from '../types';

vi.mock('meshcore-hashtag-cracker', () => ({
  GroupTextCracker: class {
    isGpuAvailable() {
      return false;
    }
    destroy() {}
    setWordlist() {}
    abort() {}
  },
}));

vi.mock('nosleep.js', () => ({
  default: class {
    enable() {}
    disable() {}
  },
}));

vi.mock('../api', () => ({
  api: {
    getUndecryptedPacketCount: vi.fn(),
  },
}));

vi.mock('../components/ui/sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { api } from '../api';

const mockedApi = vi.mocked(api);

function makePacket(id: number, payload: string): RawPacket {
  return {
    id,
    observation_id: id,
    timestamp: 1700000000 + id,
    data: `0100${payload}`,
    payload_type: 'GROUP_TEXT',
    snr: 7.5,
    rssi: -80,
    decrypted: false,
    decrypted_info: null,
  };
}

describe('CrackerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRawPacketStore();
    mockedApi.getUndecryptedPacketCount.mockResolvedValue({ count: 0 });
  });

  it('allows clearing max length while editing', async () => {
    render(<CrackerPanel channels={[]} onChannelCreate={vi.fn()} visible={false} />);

    await waitFor(() => {
      expect(mockedApi.getUndecryptedPacketCount).toHaveBeenCalled();
    });

    const maxLengthInput = screen.getByLabelText('Max Length:') as HTMLInputElement;
    fireEvent.change(maxLengthInput, { target: { value: '' } });

    expect(maxLengthInput.value).toBe('');
  });

  it('queues a new valid packet when the full rolling buffer keeps the same length', async () => {
    seedRawPacketStore({ packets: [makePacket(1, 'AA'), makePacket(2, 'BB')] });
    render(<CrackerPanel channels={[]} onChannelCreate={vi.fn()} visible={false} />);

    await waitFor(() => expect(screen.getByText(/Pending:/)).toHaveTextContent('Pending: 2'));

    act(() => recordRawPacket(makePacket(3, 'CC'), 2));

    expect(getRawPackets().map((packet) => packet.id)).toEqual([2, 3]);
    await waitFor(() => expect(screen.getByText(/Pending:/)).toHaveTextContent('Pending: 3'));
  });
});
