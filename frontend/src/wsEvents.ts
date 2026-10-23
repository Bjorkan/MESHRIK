import { t } from '@lingui/core/macro';
import type { Channel, Contact, HealthStatus, Message, MessagePath, RawPacket } from './types';
import type { components } from './generated/api-schema';

export type RadioJobDelta = components['schemas']['RadioJobSnapshot'];
export type RadioActivityDelta = components['schemas']['RadioActivityRecord'];

export interface MessageAckedPayload {
  message_id: number;
  ack_count: number;
  paths?: MessagePath[];
  packet_id?: number | null;
}

export interface ContactDeletedPayload {
  public_key: string;
}

export interface ContactResolvedPayload {
  previous_public_key: string;
  contact: Contact;
}

export interface ChannelDeletedPayload {
  key: string;
}

export interface ToastPayload {
  message: string;
  details?: string;
}

export type KnownWsEvent =
  | { type: 'health'; data: HealthStatus }
  | { type: 'message'; data: Message }
  | { type: 'contact'; data: Contact }
  | { type: 'contact_resolved'; data: ContactResolvedPayload }
  | { type: 'channel'; data: Channel }
  | { type: 'contact_deleted'; data: ContactDeletedPayload }
  | { type: 'channel_deleted'; data: ChannelDeletedPayload }
  | { type: 'raw_packet'; data: RawPacket }
  | { type: 'message_acked'; data: MessageAckedPayload }
  | { type: 'radio_job'; data: RadioJobDelta }
  | { type: 'radio_activity'; data: RadioActivityDelta }
  | { type: 'error'; data: ToastPayload }
  | { type: 'success'; data: ToastPayload }
  | { type: 'pong'; data?: null };

export interface UnknownWsEvent {
  type: 'unknown';
  rawType: string;
  data: unknown;
}

export type ParsedWsEvent = KnownWsEvent | UnknownWsEvent;

interface RawWsEnvelope {
  type?: unknown;
  data?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasNumber(value: UnknownRecord, key: string): boolean {
  return isNumber(value[key]);
}

function isContact(value: unknown): value is Contact {
  return (
    isRecord(value) &&
    hasString(value, 'public_key') &&
    hasNumber(value, 'type') &&
    hasNumber(value, 'flags')
  );
}

function isChannel(value: unknown): value is Channel {
  return isRecord(value) && hasString(value, 'key') && hasString(value, 'name');
}

function isMessagePath(value: unknown): value is MessagePath {
  return isRecord(value) && hasString(value, 'path') && hasNumber(value, 'received_at');
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasNumber(value, 'id') &&
    (value.type === 'PRIV' || value.type === 'CHAN') &&
    hasString(value, 'conversation_key') &&
    hasString(value, 'text') &&
    hasNumber(value, 'received_at') &&
    typeof value.outgoing === 'boolean' &&
    hasNumber(value, 'acked')
  );
}

function isHealth(value: unknown): value is HealthStatus {
  return isRecord(value) && typeof value.radio_connected === 'boolean';
}

function isRawPacket(value: unknown): value is RawPacket {
  return (
    isRecord(value) &&
    hasNumber(value, 'id') &&
    hasNumber(value, 'timestamp') &&
    hasString(value, 'data') &&
    hasString(value, 'payload_type') &&
    typeof value.decrypted === 'boolean'
  );
}

function isMessageAck(value: unknown): value is MessageAckedPayload {
  if (!isRecord(value) || !hasNumber(value, 'message_id') || !hasNumber(value, 'ack_count')) {
    return false;
  }
  if (
    value.paths !== undefined &&
    (!Array.isArray(value.paths) || !value.paths.every(isMessagePath))
  ) {
    return false;
  }
  return value.packet_id === undefined || value.packet_id === null || isNumber(value.packet_id);
}

function isToast(value: unknown): value is ToastPayload {
  return (
    isRecord(value) &&
    hasString(value, 'message') &&
    (value.details === undefined || typeof value.details === 'string')
  );
}

function isContactResolved(value: unknown): value is ContactResolvedPayload {
  return isRecord(value) && hasString(value, 'previous_public_key') && isContact(value.contact);
}

function isContactDeleted(value: unknown): value is ContactDeletedPayload {
  return isRecord(value) && hasString(value, 'public_key');
}

function isChannelDeleted(value: unknown): value is ChannelDeletedPayload {
  return isRecord(value) && hasString(value, 'key');
}

function isRadioJob(value: unknown): value is RadioJobDelta {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'kind') &&
    hasString(value, 'state') &&
    hasNumber(value, 'sequence')
  );
}

function isRadioActivity(value: unknown): value is RadioActivityDelta {
  return (
    isRecord(value) &&
    hasString(value, 'kind') &&
    hasString(value, 'at') &&
    hasNumber(value, 'radio_generation')
  );
}

function invalidData(type: string): never {
  throw new Error(t`Invalid WebSocket event data for ${type}`);
}

export function parseWsEvent(raw: string): ParsedWsEvent {
  const parsed: RawWsEnvelope = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error(t`Invalid WebSocket event envelope`);
  }

  switch (parsed.type) {
    case 'health':
      return isHealth(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'message':
      return isMessage(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'contact':
      return isContact(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'contact_resolved':
      return isContactResolved(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'channel':
      return isChannel(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'contact_deleted':
      return isContactDeleted(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'channel_deleted':
      return isChannelDeleted(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'raw_packet':
      return isRawPacket(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'message_acked':
      return isMessageAck(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'radio_job':
      return isRadioJob(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'radio_activity':
      return isRadioActivity(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'error':
    case 'success':
      return isToast(parsed.data)
        ? { type: parsed.type, data: parsed.data }
        : invalidData(parsed.type);
    case 'pong':
      return parsed.data === undefined || parsed.data === null
        ? { type: 'pong', data: parsed.data }
        : invalidData(parsed.type);
    default:
      return {
        type: 'unknown',
        rawType: parsed.type,
        data: parsed.data,
      };
  }
}
