import { useEffect } from 'react';

const MAP_GESTURE_SELECTOR = '.maplibregl-map, [data-page-pinch-zoom="allow"]';

function isMapGesture(event: Event): boolean {
  return event.composedPath().some((target) => {
    if (!(target instanceof Element)) {
      return false;
    }
    return target.matches(MAP_GESTURE_SELECTOR) || target.closest(MAP_GESTURE_SELECTOR) !== null;
  });
}

function preventPagePinch(event: Event): void {
  if (event.cancelable && !isMapGesture(event)) {
    event.preventDefault();
  }
}

function preventMultiTouchPagePinch(event: TouchEvent): void {
  if (event.touches.length > 1) {
    preventPagePinch(event);
  }
}

export function installPagePinchZoomGuard(documentTarget: Document = document): () => void {
  const listenerOptions: AddEventListenerOptions = { passive: false };

  // gesturestart/gesturechange are WebKit-specific. The multi-touch touchmove
  // listener is the standards-based fallback used by other touch browsers.
  documentTarget.addEventListener('gesturestart', preventPagePinch, listenerOptions);
  documentTarget.addEventListener('gesturechange', preventPagePinch, listenerOptions);
  documentTarget.addEventListener('touchmove', preventMultiTouchPagePinch, listenerOptions);

  return () => {
    documentTarget.removeEventListener('gesturestart', preventPagePinch, listenerOptions);
    documentTarget.removeEventListener('gesturechange', preventPagePinch, listenerOptions);
    documentTarget.removeEventListener('touchmove', preventMultiTouchPagePinch, listenerOptions);
  };
}

/**
 * Keep the app-like mobile shell at its initial page scale while preserving
 * ordinary one-finger interaction and MapLibre camera gestures.
 */
export function usePagePinchZoomGuard(): void {
  useEffect(() => installPagePinchZoomGuard(), []);
}
