import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TanStackBarChart,
  TanStackDonutChart,
  TanStackTimeSeriesChart,
  type ChartViewport,
} from '../components/charts/TanStackChart';

const originalMatchMedia = window.matchMedia;

function mediaQuery(matches: boolean, media: string): MediaQueryList {
  return {
    matches,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  };
}

describe('TanStack chart contract', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'light';
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    delete document.documentElement.dataset.theme;
  });

  it('renders named dual axes, formatted keyboard tooltip values and an accessible legend', async () => {
    render(
      <TanStackTimeSeriesChart
        data={[
          { category: '10:00', values: { received: 1200, delta: 12 } },
          { category: '11:00', values: { received: 1600, delta: 16 } },
        ]}
        series={[
          { key: 'received', label: 'Received', color: '#0ea5e9', axis: 'left' },
          { key: 'delta', label: 'Received Δ', color: '#14b8a6', axis: 'right', line: true },
        ]}
        height={240}
        ariaLabel="Packet counters"
        variant="area"
        valueFormatter={(value) => `${value} packets`}
      />
    );

    const chart = screen.getByRole('img', { name: 'Packet counters' });
    expect(chart).toHaveAttribute('aria-roledescription', 'chart');
    expect(chart.querySelector('desc')).toHaveTextContent(
      '2 data points for Received, Received Δ. Use arrow keys to inspect values.'
    );
    expect(chart.querySelector('[data-ts-key="yLeft-axis"]')).toBeInTheDocument();
    expect(chart.querySelector('[data-ts-key="yRight-axis"]')).toBeInTheDocument();

    const legend = await screen.findByRole('group', {
      name: 'Packet counters series visibility',
    });
    const receivedButton = within(legend).getByRole('button', {
      name: 'Toggle Received series',
    });
    expect(receivedButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(receivedButton);
    expect(receivedButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(receivedButton);
    expect(receivedButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.focus(chart);
    await waitFor(() => {
      expect(document.querySelector('.ts-chart-tooltip')).toHaveTextContent('1200 packets');
    });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.querySelector('.ts-chart-tooltip')).toHaveTextContent('1600 packets');
    });
  });

  it('uses the Charts zoom control for keyboard and touch-capable time windows', async () => {
    const onViewportChange = vi.fn();
    const viewport: ChartViewport = { start: 100, end: 300 };
    render(
      <TanStackTimeSeriesChart
        data={[
          { category: 100, values: { value: 1 } },
          { category: 200, values: { value: 2 } },
          { category: 300, values: { value: 3 } },
          { category: 400, values: { value: 4 } },
        ]}
        series={[{ key: 'value', label: 'Voltage', color: '#22c55e' }]}
        height={220}
        ariaLabel="Voltage telemetry history"
        xValueFormatter={(value) => `T${value}`}
        viewport={viewport}
        fullExtent={[100, 400]}
        onViewportChange={onViewportChange}
      />
    );

    const zoom = await screen.findByLabelText('Voltage telemetry history time window');
    expect(zoom).toHaveAttribute('tabindex', '0');
    expect(zoom).toHaveAttribute('aria-description', expect.stringContaining('T100 to T300'));

    fireEvent.keyDown(zoom, { key: '+' });
    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
      expect.objectContaining({ source: 'keyboard', action: 'zoom', type: 'commit' })
    );

    fireEvent.pointerDown(zoom, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 50 });
    fireEvent.pointerMove(zoom, { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 50 });
    fireEvent.pointerUp(zoom, { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 50 });
    expect(zoom).toBeInTheDocument();
  });

  it.each(['light', 'original'])('keeps the SVG chart readable in the %s theme', (theme) => {
    if (theme === 'original') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;

    const { container } = render(
      <TanStackBarChart
        data={[{ category: 'Flood', values: { count: 7 }, detail: '7 · 70%' }]}
        series={[{ key: 'count', label: 'Packets', color: '#0ea5e9' }]}
        height={140}
        ariaLabel="Packets by route"
      />
    );

    const chart = screen.getByRole('img', { name: 'Packets by route' });
    expect(chart).toHaveAttribute('width', '100%');
    expect(chart).toHaveAttribute('height', '100%');
    expect(container.querySelector('.ts-chart-host')).toHaveStyle({
      width: '100%',
      height: '140px',
    });
    expect(chart.querySelector('[fill="#0ea5e9"]')).toBeInTheDocument();
  });

  it('re-renders against the observed container width', async () => {
    const OriginalResizeObserver = window.ResizeObserver;
    let resize: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    window.ResizeObserver = TestResizeObserver;

    const { container } = render(
      <TanStackBarChart
        data={[{ category: 'Flood', values: { count: 7 } }]}
        series={[{ key: 'count', label: 'Packets', color: '#0ea5e9' }]}
        height={140}
        ariaLabel="Responsive packets chart"
      />
    );
    const surface = container.querySelector('.ts-chart-surface') as HTMLElement;
    expect(observe).toHaveBeenCalledWith(surface);

    act(() => {
      resize?.(
        [
          {
            target: surface,
            contentRect: { width: 320, height: 140 },
            contentBoxSize: [{ inlineSize: 320, blockSize: 140 }],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver
      );
    });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Responsive packets chart' })).toHaveAttribute(
        'viewBox',
        expect.stringMatching(/^0 0 320 /)
      )
    );
    window.ResizeObserver = OriginalResizeObserver;
  });

  it('honors reduced motion and keeps no-data and donut summaries accessible', () => {
    const matchMedia = vi.fn((query: string) =>
      mediaQuery(query.includes('reduced-motion'), query)
    );
    window.matchMedia = matchMedia;

    const { rerender } = render(
      <TanStackBarChart
        data={[]}
        series={[{ key: 'count', label: 'Packets', color: '#0ea5e9' }]}
        height={140}
        ariaLabel="Empty packets chart"
      />
    );
    expect(screen.getByRole('img', { name: 'Empty packets chart' })).toHaveTextContent(
      'No chart data available.'
    );

    rerender(
      <TanStackDonutChart
        data={[
          { name: '1-byte', value: 8, color: '#22c55e' },
          { name: '2-byte', value: 3, color: '#0ea5e9' },
        ]}
        height={120}
        ariaLabel="Path hash width distribution"
      />
    );
    const donut = screen.getByRole('img', { name: 'Path hash width distribution' });
    expect(donut.querySelector('desc')).toHaveTextContent('2 slices: 1-byte, 2-byte.');
    fireEvent.focus(donut);
    expect(document.querySelector('.ts-chart-tooltip')).toHaveTextContent('2-byte: 3');
    rerender(
      <TanStackDonutChart
        data={[
          { name: '1-byte', value: 9, color: '#22c55e' },
          { name: '2-byte', value: 2, color: '#0ea5e9' },
        ]}
        height={120}
        ariaLabel="Path hash width distribution"
      />
    );
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });
});
