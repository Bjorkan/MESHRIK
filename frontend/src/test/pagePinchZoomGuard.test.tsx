import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePagePinchZoomGuard } from '../hooks/usePagePinchZoomGuard';

function dispatchTouchMove(target: Element, touchCount: number, cancelable = true): TouchEvent {
  const event = new Event('touchmove', { bubbles: true, cancelable }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: Array.from({ length: touchCount }, () => ({})),
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchGesture(target: Element, type: 'gesturestart' | 'gesturechange'): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('usePagePinchZoomGuard', () => {
  it('blocks cancelable page pinch gestures but leaves single-touch interaction alone', () => {
    const { unmount } = renderHook(() => usePagePinchZoomGuard());
    const target = document.createElement('div');
    document.body.append(target);

    expect(dispatchTouchMove(target, 1).defaultPrevented).toBe(false);
    expect(dispatchTouchMove(target, 2).defaultPrevented).toBe(true);
    expect(dispatchGesture(target, 'gesturestart').defaultPrevented).toBe(true);
    expect(dispatchGesture(target, 'gesturechange').defaultPrevented).toBe(true);

    unmount();
    target.remove();
  });

  it('does not cancel MapLibre or explicitly exempted multi-touch gestures', () => {
    const { unmount } = renderHook(() => usePagePinchZoomGuard());
    const map = document.createElement('div');
    map.className = 'maplibregl-map';
    const mapCanvas = document.createElement('canvas');
    map.append(mapCanvas);
    document.body.append(map);

    const exempt = document.createElement('div');
    exempt.dataset.pagePinchZoom = 'allow';
    document.body.append(exempt);

    expect(dispatchTouchMove(mapCanvas, 2).defaultPrevented).toBe(false);
    expect(dispatchGesture(mapCanvas, 'gesturestart').defaultPrevented).toBe(false);
    expect(dispatchTouchMove(exempt, 2).defaultPrevented).toBe(false);

    unmount();
    map.remove();
    exempt.remove();
  });

  it('only prevents cancelable events and removes every listener on unmount', () => {
    const { unmount } = renderHook(() => usePagePinchZoomGuard());
    const target = document.createElement('button');
    document.body.append(target);

    expect(dispatchTouchMove(target, 2, false).defaultPrevented).toBe(false);

    unmount();

    expect(dispatchTouchMove(target, 2).defaultPrevented).toBe(false);
    expect(dispatchGesture(target, 'gesturestart').defaultPrevented).toBe(false);

    target.remove();
  });
});
