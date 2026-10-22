import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebSocket } from '../useWebSocket';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  send(): void {}

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

const originalWebSocket = globalThis.WebSocket;

describe('useWebSocket lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    window.history.replaceState(null, '', '/');
    vi.useRealTimers();
  });

  it('connects to the root API from a nested pathname', () => {
    window.history.replaceState(null, '', '/channel/example');

    renderHook(() => useWebSocket({}));

    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3000/api/ws');
  });

  it('does not reconnect after hook unmount cleanup', () => {
    const { unmount } = renderHook(() => useWebSocket({}));

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      unmount();
    });

    act(() => {
      vi.advanceTimersByTime(3100);
    });

    // Unmount-triggered socket close should not start a new connection.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('ignores delayed callbacks from a superseded socket after reconnect', () => {
    const onConnectionChange = vi.fn();
    const onHealth = vi.fn();
    renderHook(() => useWebSocket({ onConnectionChange, onHealth }));

    expect(MockWebSocket.instances).toHaveLength(1);
    const superseded = MockWebSocket.instances[0];
    act(() => superseded.emitClose());
    act(() => vi.advanceTimersByTime(3000));

    // Explicit reconnection makes the stale-socket scenario independent of
    // React 18/19 StrictMode effect replay behavior.
    expect(MockWebSocket.instances).toHaveLength(2);
    const active = MockWebSocket.instances[1];

    act(() => {
      active.emitOpen();
      superseded.emitOpen();
      superseded.emitMessage(JSON.stringify({ type: 'health', data: { status: 'stale' } }));
      superseded.emitClose();
      vi.advanceTimersByTime(3100);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onConnectionChange).toHaveBeenCalledTimes(2);
    expect(onConnectionChange).toHaveBeenLastCalledWith('live');
    expect(onHealth).not.toHaveBeenCalled();
  });

  it('reconnects once after the active socket closes and reports recovery', () => {
    const onConnectionChange = vi.fn();
    const onReconnect = vi.fn();
    renderHook(() => useWebSocket({ onConnectionChange, onReconnect }));
    const first = MockWebSocket.instances[0];

    act(() => first.emitOpen());
    act(() => first.emitClose());
    expect(onConnectionChange).toHaveBeenLastCalledWith('offline');

    act(() => vi.advanceTimersByTime(3000));
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => MockWebSocket.instances[1].emitOpen());
    expect(onConnectionChange).toHaveBeenLastCalledWith('live');
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps delayed socket callbacks inert after unmount', () => {
    const onConnectionChange = vi.fn();
    const onHealth = vi.fn();
    const { unmount } = renderHook(() => useWebSocket({ onConnectionChange, onHealth }));
    const socket = MockWebSocket.instances[0];

    unmount();
    act(() => {
      socket.emitOpen();
      socket.emitMessage(JSON.stringify({ type: 'health', data: { status: 'stale' } }));
      socket.emitClose();
      vi.advanceTimersByTime(3100);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(onHealth).not.toHaveBeenCalled();
  });
});
