import type { Rect, Virtualizer } from '@tanstack/react-virtual';

const DEFAULT_FALLBACK_VIEWPORT_HEIGHT = 640;

/**
 * Element measurement shared by every scroll-window owner. Browsers report the
 * real viewport; hidden panes and DOM test environments get a bounded fallback
 * so a virtual list never renders a blank first frame.
 */
export function observeElementRectWithFallback<
  TScrollElement extends Element,
  TItemElement extends Element,
>(fallbackHeight = DEFAULT_FALLBACK_VIEWPORT_HEIGHT) {
  return (instance: Virtualizer<TScrollElement, TItemElement>, callback: (rect: Rect) => void) => {
    const element = instance.scrollElement;
    if (!element) return;

    const report = () => {
      const rect = element.getBoundingClientRect();
      callback({ width: rect.width, height: rect.height || fallbackHeight });
    };
    report();

    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  };
}

/** Keep the estimate until a variable-height row has a non-zero layout. */
export function measureElementWithFallback<
  TScrollElement extends Element,
  TItemElement extends Element,
>(estimateSize: (index: number) => number) {
  return (
    element: TItemElement,
    _entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<TScrollElement, TItemElement>
  ) => element.getBoundingClientRect().height || estimateSize(instance.indexFromElement(element));
}
