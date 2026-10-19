import { useEffect, useRef, useCallback } from 'react';
import type { Channel, HealthStatus, Contact, Message, MessagePath, RawPacket } from './types';
import { parseWsEvent, type RadioJobDelta, type RadioActivityDelta } from './wsEvents';

interface ErrorEvent {
  message: string;
  details?: string;
}

interface SuccessEvent {
  message: string;
  details?: string;
}

export interface UseWebSocketOptions {
  onHealth?: (health: HealthStatus) => void;
  onRadioJob?: (job: RadioJobDelta) => void;
  onRadioActivity?: (activity: RadioActivityDelta) => void;
  onMessage?: (message: Message) => void;
  onContact?: (contact: Contact) => void;
  onContactResolved?: (previousPublicKey: string, contact: Contact) => void;
  onContactDeleted?: (publicKey: string) => void;
  onChannel?: (channel: Channel) => void;
  onChannelDeleted?: (key: string) => void;
  onRawPacket?: (packet: RawPacket) => void;
  onMessageAcked?: (
    messageId: number,
    ackCount: number,
    paths?: MessagePath[],
    packetId?: number | null
  ) => void;
  onError?: (error: ErrorEvent) => void;
  onSuccess?: (success: SuccessEvent) => void;
  onReconnect?: () => void;
  onConnectionChange?: (state: 'live' | 'offline') => void;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const hasConnectedRef = useRef(false);
  const parseDiagnosticCountRef = useRef(0);

  // Store options in ref to avoid stale closures in WebSocket handlers.
  // The onmessage callback captures this ref, and we keep the ref updated
  // with the latest handlers. This way, even though the WebSocket connection
  // is only created once, it always calls the current handlers.
  const optionsRef = useRef<UseWebSocketOptions>(options);

  // Keep the ref updated with latest options
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Connect function - uses ref for handlers to avoid stale closures
  // No dependencies needed since we access handlers through ref
  const connect = useCallback(() => {
    // Always connect at the application origin, regardless of the active route.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      optionsRef.current.onConnectionChange?.('live');
      // Connection established (or re-established after disconnect)
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (hasConnectedRef.current) {
        optionsRef.current.onReconnect?.();
      }
      hasConnectedRef.current = true;
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      optionsRef.current.onConnectionChange?.('offline');
      // Connection lost — will auto-reconnect after delay
      wsRef.current = null;

      if (!shouldReconnectRef.current) {
        return;
      }

      // Reconnect after 3 seconds
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (!shouldReconnectRef.current || wsRef.current !== null) return;
        // Reconnect attempt after disconnect
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      if (wsRef.current !== ws) return;
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const msg = parseWsEvent(event.data);
        // Access handlers through ref to always use current versions
        const handlers = optionsRef.current;

        switch (msg.type) {
          case 'health':
            handlers.onHealth?.(msg.data);
            break;
          case 'message':
            handlers.onMessage?.(msg.data);
            break;
          case 'contact':
            handlers.onContact?.(msg.data);
            break;
          case 'contact_resolved': {
            handlers.onContactResolved?.(msg.data.previous_public_key, msg.data.contact);
            break;
          }
          case 'channel':
            handlers.onChannel?.(msg.data);
            break;
          case 'contact_deleted':
            handlers.onContactDeleted?.(msg.data.public_key);
            break;
          case 'channel_deleted':
            handlers.onChannelDeleted?.(msg.data.key);
            break;
          case 'raw_packet':
            handlers.onRawPacket?.(msg.data);
            break;
          case 'radio_job':
            handlers.onRadioJob?.(msg.data);
            break;
          case 'radio_activity':
            handlers.onRadioActivity?.(msg.data);
            break;
          case 'message_acked': {
            handlers.onMessageAcked?.(
              msg.data.message_id,
              msg.data.ack_count,
              msg.data.paths,
              msg.data.packet_id
            );
            break;
          }
          case 'error':
            handlers.onError?.(msg.data);
            break;
          case 'success':
            handlers.onSuccess?.(msg.data);
            break;
          case 'pong':
            // Heartbeat response, ignore
            break;
          case 'unknown':
            console.warn('Unknown WebSocket message type:', msg.rawType);
        }
      } catch (error) {
        const count = parseDiagnosticCountRef.current;
        if (count < 5) {
          console.error(
            'Rejected invalid WebSocket message:',
            error instanceof Error ? error.message : 'Unknown parse error'
          );
        } else if (count === 5) {
          console.error('Further invalid WebSocket message diagnostics suppressed');
        }
        parseDiagnosticCountRef.current = count + 1;
      }
    };

    wsRef.current = ws;
  }, []); // No dependencies - handlers accessed through ref

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();

    // Ping every 30 seconds to keep connection alive
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('ping');
      }
    }, 30000);

    return () => {
      shouldReconnectRef.current = false;
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const activeSocket = wsRef.current;
      wsRef.current = null;
      activeSocket?.close();
    };
  }, [connect]);
}
