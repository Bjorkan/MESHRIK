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
    this.onclose?.();
  }

  send(): void {}
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
});
