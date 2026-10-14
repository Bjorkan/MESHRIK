import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';

import type { RawPacket } from '../types';
import { appendRawPacketUnique } from '../utils/rawPacketIdentity';
import {
  MAX_RAW_PACKET_STATS_OBSERVATIONS,
  summarizeRawPacketForStats,
  type RawPacketStatsSessionState,
} from '../utils/rawPacketStats';

/**
 * Live radio traffic arrives continuously — every packet the node overhears, not
 * just our own conversations. Holding that stream in App state re-rendered the whole
 * tree (including the message list) on every packet, which made typing crawl in
 * conversations with a lot of history.
 *
 * The stream lives here instead, outside React, so only the views that actually read
 * packets (map, visualizer, raw feed, cracker) re-render when one arrives.
 */

export const MAX_RAW_PACKETS = 500;

function createStatsSession(): RawPacketStatsSessionState {
  return {
    sessionStartedAt: Date.now(),
    totalObservedPackets: 0,
    trimmedObservationCount: 0,
    observations: [],
  };
}

interface RawPacketStoreState {
  packets: RawPacket[];
  statsSession: RawPacketStatsSessionState;
}

export const rawPacketStore = new Store<RawPacketStoreState>({
  packets: [],
  statsSession: createStatsSession(),
});

function observePacket(
  session: RawPacketStatsSessionState,
  packet: RawPacket
): RawPacketStatsSessionState {
  const observation = summarizeRawPacketForStats(packet);
  if (
    session.observations.some(
      (candidate) => candidate.observationKey === observation.observationKey
    )
  ) {
    return session;
  }

  const observations = [...session.observations, observation];
  if (observations.length <= MAX_RAW_PACKET_STATS_OBSERVATIONS) {
    return {
      ...session,
      totalObservedPackets: session.totalObservedPackets + 1,
      observations,
    };
  }

  const overflow = observations.length - MAX_RAW_PACKET_STATS_OBSERVATIONS;
  return {
    ...session,
    totalObservedPackets: session.totalObservedPackets + 1,
    trimmedObservationCount: session.trimmedObservationCount + overflow,
    observations: observations.slice(overflow),
  };
}

/** Record one observed packet into both the rolling buffer and the session stats. */
export function recordRawPacket(packet: RawPacket, maxPackets: number = MAX_RAW_PACKETS): void {
  rawPacketStore.setState((state) => {
    const packets = appendRawPacketUnique(state.packets, packet, maxPackets);
    const statsSession = observePacket(state.statsSession, packet);
    return packets === state.packets && statsSession === state.statsSession
      ? state
      : { packets, statsSession };
  });
}

/**
 * Drop the buffered packets on reconnect — we may have missed traffic while offline.
 * Session stats deliberately survive: they describe the whole observation session.
 */
export function clearRawPackets(): void {
  rawPacketStore.setState((state) =>
    state.packets.length === 0 ? state : { ...state, packets: [] }
  );
}

/** Full reset, including session stats. Used by tests to isolate cases. */
export function resetRawPacketStore(): void {
  rawPacketStore.setState(() => ({ packets: [], statsSession: createStatsSession() }));
}

/**
 * Install a specific stream/stats snapshot. Exists so tests can drive the views
 * from fixed fixtures — including stats shapes that a live packet feed would take
 * minutes to produce — without reintroducing prop drilling through the app tree.
 */
export function seedRawPacketStore(next: {
  packets?: RawPacket[];
  statsSession?: RawPacketStatsSessionState;
}): void {
  // Copy rather than alias. The whole store rests on "a snapshot is immutable, and its
  // identity changes only when its contents do". Holding the caller's array would let
  // them mutate the live snapshot in place. TanStack Store selectors compare snapshot
  // identity, so an aliased mutation could otherwise leave the UI on a stale selection.
  rawPacketStore.setState((state) => ({
    packets: next.packets ? [...next.packets] : state.packets,
    statsSession: next.statsSession
      ? {
          ...next.statsSession,
          observations: [...next.statsSession.observations],
        }
      : state.statsSession,
  }));
}

export function getRawPackets(): RawPacket[] {
  return rawPacketStore.state.packets;
}

export function getRawPacketStatsSession(): RawPacketStatsSessionState {
  return rawPacketStore.state.statsSession;
}

export function useRawPackets(): RawPacket[] {
  return useStore(rawPacketStore, (state) => state.packets);
}

function isCrackablePacket(packet: RawPacket): boolean {
  return packet.payload_type === 'GROUP_TEXT' && !packet.decrypted;
}

function sameCrackablePackets(previous: RawPacket[], next: RawPacket[]): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (packet, index) => packet.id === next[index]?.id && packet.data === next[index]?.data
    )
  );
}

/**
 * Select only the rolling-buffer membership consumed by the channel cracker.
 * The comparator ignores unrelated RF packets, but detects an eligible packet
 * replacing another while the full buffer remains the same length.
 */
export function useCrackableRawPackets(): RawPacket[] {
  return useStore(
    rawPacketStore,
    (state) => state.packets.filter(isCrackablePacket),
    sameCrackablePackets
  );
}

export function useRawPacketStatsSession(): RawPacketStatsSessionState {
  return useStore(rawPacketStore, (state) => state.statsSession);
}
