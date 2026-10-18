import { forwardRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NeighborsMiniMap } from '../components/NeighborsMiniMap';
import { PathRouteMap } from '../components/PathRouteMap';
import { THEME_CHANGE_EVENT } from '../utils/theme';

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef(
    (
      {
        children,
        attributionControl,
        mapStyle,
      }: { children: React.ReactNode; attributionControl?: boolean; mapStyle?: string },
      _ref
    ) => (
      <div
        data-testid="embedded-map"
        data-default-attribution={String(attributionControl)}
        data-map-style={mapStyle}
      >
        {children}
      </div>
    )
  ),
  AttributionControl: ({ compact, position }: { compact?: boolean; position?: string }) => (
    <div
      data-testid="embedded-attribution"
      data-compact={String(compact)}
      data-position={position}
    />
  ),
  Marker: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Popup: ({
    children,
    closeOnClick,
    onClose,
  }: {
    children: React.ReactNode;
    closeOnClick?: boolean;
    onClose?: () => void;
  }) => (
    <div data-testid="embedded-popup" data-close-on-click={String(closeOnClick)}>
      {children}
      <button type="button" onClick={onClose} aria-label="Simulate embedded map background click" />
    </div>
  ),
  Source: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Layer: () => null,
}));

function expectCompactAttribution() {
  const attribution = screen.getByTestId('embedded-attribution');
  expect(attribution).toHaveAttribute('data-compact', 'true');
  expect(attribution).toHaveAttribute('data-position', 'bottom-right');
  expect(attribution.parentElement).toHaveAttribute('data-default-attribution', 'false');
}

describe('embedded maps', () => {
  beforeEach(() => localStorage.clear());

  it('uses collapsed attribution on the repeater neighbors map', () => {
    render(
      <NeighborsMiniMap
        radioLat={59.33}
        radioLon={18.07}
        neighbors={[{ lat: 59.34, lon: 18.08, name: 'Nearby node', pubkey_prefix: 'aabb', snr: 4 }]}
      />
    );

    expectCompactAttribution();
  });

  it('switches and closes repeater-neighbor popups on map background clicks', () => {
    render(
      <NeighborsMiniMap
        radioLat={59.33}
        radioLon={18.07}
        radioName="Local radio"
        neighbors={[{ lat: 59.34, lon: 18.08, name: 'Nearby node', pubkey_prefix: 'aabb', snr: 4 }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Local radio on map' }));
    expect(screen.getByTestId('embedded-popup')).toHaveTextContent('Local radio');
    fireEvent.click(screen.getByRole('button', { name: 'Show Nearby node on map' }));
    expect(screen.getByTestId('embedded-popup')).toHaveTextContent('Nearby node');
    expect(screen.getByTestId('embedded-popup')).toHaveAttribute('data-close-on-click', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Simulate embedded map background click' }));
    expect(screen.queryByTestId('embedded-popup')).not.toBeInTheDocument();
  });

  it('keeps neighbor-map popup state while changing the theme style in place', async () => {
    render(
      <NeighborsMiniMap radioLat={59.33} radioLon={18.07} radioName="Local radio" neighbors={[]} />
    );
    const map = screen.getByTestId('embedded-map');
    fireEvent.click(screen.getByRole('button', { name: 'Show Local radio on map' }));

    localStorage.setItem('meshrik-theme', 'light');
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'light' }));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-map')).toHaveAttribute(
        'data-map-style',
        'https://tiles.openfreemap.org/styles/liberty'
      )
    );
    expect(screen.getByTestId('embedded-map')).toBe(map);
    expect(screen.getByTestId('embedded-popup')).toHaveTextContent('Local radio');
  });

  it('uses collapsed attribution on the message route map', () => {
    render(
      <PathRouteMap
        resolved={{
          sender: { name: 'Sender', prefix: 'aa', lat: 59.33, lon: 18.07 },
          hops: [],
          receiver: {
            name: 'Receiver',
            prefix: 'bb',
            lat: 59.34,
            lon: 18.08,
            publicKey: null,
          },
          totalDistances: [1],
          hasGaps: false,
        }}
        senderInfo={{ name: 'Sender', publicKeyOrPrefix: 'aa', lat: 59.33, lon: 18.07 }}
      />
    );

    expectCompactAttribution();
  });

  it('closes message-route popups on map background clicks', () => {
    render(
      <PathRouteMap
        resolved={{
          sender: { name: 'Sender', prefix: 'aa', lat: 59.33, lon: 18.07 },
          hops: [],
          receiver: { name: 'Receiver', prefix: 'bb', lat: 59.34, lon: 18.08, publicKey: null },
          totalDistances: [1],
          hasGaps: false,
        }}
        senderInfo={{ name: 'Sender', publicKeyOrPrefix: 'aa', lat: 59.33, lon: 18.07 }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show S node details' }));
    expect(screen.getByTestId('embedded-popup')).toHaveAttribute('data-close-on-click', 'true');
    expect(screen.getByTestId('embedded-popup')).toHaveTextContent('Sender');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate embedded map background click' }));
    expect(screen.queryByTestId('embedded-popup')).not.toBeInTheDocument();
  });

  it('keeps route overlays and popup state while changing the theme style in place', async () => {
    render(
      <PathRouteMap
        resolved={{
          sender: { name: 'Sender', prefix: 'aa', lat: 59.33, lon: 18.07 },
          hops: [],
          receiver: { name: 'Receiver', prefix: 'bb', lat: 59.34, lon: 18.08, publicKey: null },
          totalDistances: [1],
          hasGaps: false,
        }}
        senderInfo={{ name: 'Sender', publicKeyOrPrefix: 'aa', lat: 59.33, lon: 18.07 }}
      />
    );
    const map = screen.getByTestId('embedded-map');
    fireEvent.click(screen.getByRole('button', { name: 'Show S node details' }));

    localStorage.setItem('meshrik-theme', 'light');
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'light' }));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-map')).toHaveAttribute(
        'data-map-style',
        'https://tiles.openfreemap.org/styles/liberty'
      )
    );
    expect(screen.getByTestId('embedded-map')).toBe(map);
    expect(screen.getByTestId('embedded-popup')).toHaveTextContent('Sender');
    expect(screen.getByRole('button', { name: 'Show R node details' })).toBeInTheDocument();
  });
});
