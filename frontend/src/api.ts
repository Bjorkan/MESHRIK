import type {
  AppSettings,
  AppSettingsUpdate,
  BulkCreateHashtagChannelsResult,
  BulkDeleteContactsResult,
  Channel,
  ChannelDetail,
  CommandResponse,
  Contact,
  ContactDeleteResult,
  ContactAnalytics,
  ContactAdvertPathSummary,
  ContactTelemetryResponse,
  FanoutConfig,
  HealthStatus,
  MaintenanceResult,
  Message,
  MessagesAroundResponse,
  RawPacket,
  RadioConfig,
  RadioConfigUpdate,
  RadioDiscoveryResponse,
  RadioRegionDiscoveryResponse,
  RadioTraceHopRequest,
  RadioTraceResponse,
  PathDiscoveryResponse,
  PushSubscriptionInfo,
  ResendChannelMessageResponse,
  RepeaterAclResponse,
  RepeaterAdvertIntervalsResponse,
  RepeaterLoginResponse,
  RepeaterLppTelemetryResponse,
  RepeaterNeighborsResponse,
  RepeaterNodeInfoResponse,
  RepeaterOwnerInfoResponse,
  RepeaterRadioSettingsResponse,
  RepeaterRegionsResponse,
  RepeaterStatusResponse,
  TelemetryHistoryEntry,
  TelemetrySchedule,
  TrackedTelemetryContactsResponse,
  TrackedTelemetryResponse,
  StatisticsResponse,
  TraceResponse,
  UnreadCounts,
} from './types';
import type { paths } from './generated/api-schema';

const API_BASE = './api';

/** Extract the 200 JSON response type for a path + method.
 * @public — available for typed fetch wrappers; unused until schemas are fully hardened. */
export type ApiResponse<
  P extends keyof paths,
  M extends keyof paths[P] & string,
> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer R } } };
}
  ? R
  : never;

export type ApiRequestBody<
  P extends keyof paths,
  M extends keyof paths[P] & string,
> = paths[P][M] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? NonNullable<B>
  : never;

export type ApiQuery<
  P extends keyof paths,
  M extends keyof paths[P] & string,
> = paths[P][M] extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

export type ApiPathParams<
  P extends keyof paths,
  M extends keyof paths[P] & string,
> = paths[P][M] extends { parameters: { path?: infer Params } } ? Params : never;

type ContactsResponse =
  paths['/api/contacts']['get']['responses'][200]['content']['application/json'];
type MessagesResponse =
  paths['/api/messages']['get']['responses'][200]['content']['application/json'];
type CreateContactBody = ApiRequestBody<'/api/contacts', 'post'>;
type CreateChannelBody = ApiRequestBody<'/api/channels', 'post'>;
type SendDirectMessageBody = ApiRequestBody<'/api/messages/direct', 'post'>;
type SendChannelMessageBody = ApiRequestBody<'/api/messages/channel', 'post'>;
type UpdateSettingsBody = ApiRequestBody<'/api/settings', 'patch'>;
type RestContact = Contact & Required<Pick<ContactsResponse[number], 'effective_route_source'>>;
type RestMessage = Message & Required<Pick<MessagesResponse[number], 'send_status'>>;
type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body !== undefined;
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      ...(hasBody && { 'Content-Type': 'application/json' }),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const errorText = await res.text();
    // FastAPI returns errors as {"detail": "message"}, extract the message
    let errorMessage = errorText || res.statusText;
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.detail) {
        errorMessage = errorJson.detail;
      }
    } catch {
      // Not JSON, use raw text
    }
    throw new Error(errorMessage);
  }
  return res.json();
}

/**
 * FastAPI serializes Pydantic defaults, although OpenAPI marks defaulted response fields optional.
 * Keep that refinement explicit at the REST boundary while retaining the generated wire contract.
 */
async function fetchDefaultedJson<TWire, TView>(
  url: string,
  options?: RequestInit
): Promise<TView> {
  return (await fetchJson<TWire>(url, options)) as unknown as TView;
}

/** Bind each request to its generated OpenAPI operation while retaining the shared fetch behavior. */
function fetchApi<P extends keyof paths, M extends keyof paths[P] & string>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<P, M>> {
  return fetchJson<ApiResponse<P, M>>(url, options);
}

/** Refine fields that FastAPI always emits although OpenAPI marks their defaults optional. */
function fetchApiView<P extends keyof paths, M extends keyof paths[P] & string, TView>(
  url: string,
  options?: RequestInit,
  ..._contractCheck: ApiResponse<P, M> extends DeepPartial<TView> ? [] : [never]
): Promise<TView> {
  return fetchDefaultedJson<ApiResponse<P, M>, TView>(url, options);
}

/** Keep weak legacy OpenAPI responses endpoint-bound until their backend models are hardened. */
function fetchApiLooseView<P extends keyof paths, M extends keyof paths[P] & string, TView>(
  url: string,
  options?: RequestInit
): Promise<TView> {
  return fetchDefaultedJson<ApiResponse<P, M>, TView>(url, options);
}

function apiBody<P extends keyof paths, M extends keyof paths[P] & string>(
  value: ApiRequestBody<P, M>
): string {
  return jsonBody(value);
}

function jsonBody<T>(value: T): string {
  return JSON.stringify(value);
}

/** Check if an error is an AbortError (request was cancelled) */
export function isAbortError(err: unknown): boolean {
  // DOMException is thrown by fetch when aborted, and it's not an Error subclass
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  // Also check for Error with AbortError name (for compatibility)
  return err instanceof Error && err.name === 'AbortError';
}

interface DecryptResult {
  started: boolean;
  total_packets: number;
  message: string;
}

export const api = {
  // Health
  getHealth: () => fetchApiView<'/api/health', 'get', HealthStatus>('/health'),

  // Scheduler snapshots (#41): read-only until operation-specific producers migrate.
  getRadioJobs: (
    params: {
      status?: ApiQuery<'/api/radio/jobs', 'get'>['status'];
      limit?: number;
      cursor?: number;
    } = {}
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', String(params.cursor));
    return fetchApi<'/api/radio/jobs', 'get'>(`/radio/jobs?${query}`);
  },
  getRadioJob: (jobId: string) =>
    fetchApi<'/api/radio/jobs/{job_id}', 'get'>(`/radio/jobs/${encodeURIComponent(jobId)}`),
  cancelRadioJob: (jobId: string) =>
    fetchApi<'/api/radio/jobs/{job_id}/cancel', 'post'>(
      `/radio/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' }
    ),
  getRadioActivity: (params: { cursor?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', String(params.cursor));
    return fetchApi<'/api/radio/activity', 'get'>(`/radio/activity?${query}`);
  },

  // Radio config
  getRadioConfig: () => fetchApiView<'/api/radio/config', 'get', RadioConfig>('/radio/config'),
  updateRadioConfig: (config: RadioConfigUpdate & ApiRequestBody<'/api/radio/config', 'patch'>) =>
    fetchApiView<'/api/radio/config', 'patch', RadioConfig>('/radio/config', {
      method: 'PATCH',
      body: apiBody<'/api/radio/config', 'patch'>(config),
    }),
  getPrivateKey: () =>
    fetchApiView<'/api/radio/private-key', 'get', { private_key: string }>('/radio/private-key'),
  setPrivateKey: (privateKey: ApiRequestBody<'/api/radio/private-key', 'put'>['private_key']) =>
    fetchApiView<'/api/radio/private-key', 'put', { status: string }>('/radio/private-key', {
      method: 'PUT',
      body: apiBody<'/api/radio/private-key', 'put'>({ private_key: privateKey }),
    }),
  sendAdvertisement: (mode: ApiRequestBody<'/api/radio/advertise', 'post'>['mode'] = 'flood') =>
    fetchApiView<'/api/radio/advertise', 'post', { status: string }>('/radio/advertise', {
      method: 'POST',
      body: apiBody<'/api/radio/advertise', 'post'>({ mode }),
    }),
  discoverMesh: (target: ApiRequestBody<'/api/radio/discover', 'post'>['target']) =>
    fetchApiView<'/api/radio/discover', 'post', RadioDiscoveryResponse>('/radio/discover', {
      method: 'POST',
      body: apiBody<'/api/radio/discover', 'post'>({ target }),
    }),
  discoverRegions: (publicKeys?: string[]) =>
    fetchApiView<'/api/radio/discover-regions', 'post', RadioRegionDiscoveryResponse>(
      '/radio/discover-regions',
      {
        method: 'POST',
        body: apiBody<'/api/radio/discover-regions', 'post'>(
          publicKeys && publicKeys.length > 0
            ? { public_keys: publicKeys, max_repeaters: 5 }
            : { max_repeaters: 5 }
        ),
      }
    ),
  requestRadioTrace: (
    hopHashBytes: ApiRequestBody<'/api/radio/trace', 'post'>['hop_hash_bytes'],
    hops: ApiRequestBody<'/api/radio/trace', 'post'>['hops'] & RadioTraceHopRequest[]
  ) =>
    fetchApiView<'/api/radio/trace', 'post', RadioTraceResponse>('/radio/trace', {
      method: 'POST',
      body: apiBody<'/api/radio/trace', 'post'>({ hop_hash_bytes: hopHashBytes, hops }),
    }),
  rebootRadio: () =>
    fetchApiView<'/api/radio/reboot', 'post', { status: string; message: string }>(
      '/radio/reboot',
      {
        method: 'POST',
      }
    ),
  disconnectRadio: () =>
    fetchApiView<
      '/api/radio/disconnect',
      'post',
      { status: string; message: string; connected: boolean; paused: boolean }
    >('/radio/disconnect', {
      method: 'POST',
    }),
  reconnectRadio: () =>
    fetchApiView<
      '/api/radio/reconnect',
      'post',
      { status: string; message: string; connected: boolean }
    >('/radio/reconnect', { method: 'POST' }),

  // Contacts
  getContacts: async (
    limit: ApiQuery<'/api/contacts', 'get'>['limit'] = 100,
    offset: ApiQuery<'/api/contacts', 'get'>['offset'] = 0,
    signal?: AbortSignal
  ): Promise<Contact[]> =>
    fetchApiView<'/api/contacts', 'get', RestContact[]>(
      `/contacts?limit=${limit}&offset=${offset}`,
      { signal }
    ),
  getRepeaterAdvertPaths: (
    limitPerRepeater: ApiQuery<
      '/api/contacts/repeaters/advert-paths',
      'get'
    >['limit_per_repeater'] = 10
  ) =>
    fetchApiView<'/api/contacts/repeaters/advert-paths', 'get', ContactAdvertPathSummary[]>(
      `/contacts/repeaters/advert-paths?limit_per_repeater=${limitPerRepeater}`
    ),
  getContactAnalytics: (
    params: {
      publicKey?: ApiQuery<'/api/contacts/analytics', 'get'>['public_key'];
      name?: ApiQuery<'/api/contacts/analytics', 'get'>['name'];
    },
    signal?: AbortSignal
  ) => {
    const searchParams = new URLSearchParams();
    if (params.publicKey) searchParams.set('public_key', params.publicKey);
    if (params.name) searchParams.set('name', params.name);
    return fetchApiView<'/api/contacts/analytics', 'get', ContactAnalytics>(
      `/contacts/analytics?${searchParams.toString()}`,
      { signal }
    );
  },
  deleteContact: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}', 'delete', ContactDeleteResult>(
      `/contacts/${publicKey}`,
      {
        method: 'DELETE',
      }
    ),
  bulkDeleteContacts: (publicKeys: string[]) =>
    fetchApiView<'/api/contacts/bulk-delete', 'post', BulkDeleteContactsResult>(
      '/contacts/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: apiBody<'/api/contacts/bulk-delete', 'post'>({ public_keys: publicKeys }),
      }
    ),
  createContact: (
    publicKey: CreateContactBody['public_key'],
    name?: CreateContactBody['name'],
    tryHistorical: CreateContactBody['try_historical'] = false,
    type: CreateContactBody['type'] = 0
  ) =>
    fetchApiView<'/api/contacts', 'post', Contact>('/contacts', {
      method: 'POST',
      body: jsonBody<CreateContactBody>({
        public_key: publicKey,
        ...(name !== undefined && { name }),
        type,
        try_historical: tryHistorical,
      }),
    }),
  markContactRead: (
    publicKey: string,
    messageId?: ApiQuery<'/api/contacts/{public_key}/mark-read', 'post'>['message_id']
  ) =>
    fetchApi<'/api/contacts/{public_key}/mark-read', 'post'>(
      `/contacts/${publicKey}/mark-read${messageId === undefined ? '' : `?message_id=${messageId}`}`,
      { method: 'POST' }
    ),
  sendRepeaterCommand: (publicKey: string, command: string) =>
    fetchApiView<'/api/contacts/{public_key}/command', 'post', CommandResponse>(
      `/contacts/${publicKey}/command`,
      {
        method: 'POST',
        body: apiBody<'/api/contacts/{public_key}/command', 'post'>({ command }),
      }
    ),
  requestTrace: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/trace', 'post', TraceResponse>(
      `/contacts/${publicKey}/trace`,
      {
        method: 'POST',
      }
    ),
  requestPathDiscovery: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/path-discovery', 'post', PathDiscoveryResponse>(
      `/contacts/${publicKey}/path-discovery`,
      {
        method: 'POST',
      }
    ),
  setContactRoutingOverride: (publicKey: string, route: string) =>
    fetchApi<'/api/contacts/{public_key}/routing-override', 'post'>(
      `/contacts/${publicKey}/routing-override`,
      {
        method: 'POST',
        body: apiBody<'/api/contacts/{public_key}/routing-override', 'post'>({ route }),
      }
    ),

  // Channels
  getChannels: (signal?: AbortSignal) =>
    fetchApiView<'/api/channels', 'get', Channel[]>('/channels', { signal }),
  createChannel: (name: CreateChannelBody['name'], key?: CreateChannelBody['key']) =>
    fetchApiView<'/api/channels', 'post', Channel>('/channels', {
      method: 'POST',
      body: jsonBody<CreateChannelBody>({ name, key }),
    }),
  bulkCreateHashtagChannels: (channelNames: string[], tryHistorical = false) =>
    fetchApiView<'/api/channels/bulk-hashtag', 'post', BulkCreateHashtagChannelsResult>(
      '/channels/bulk-hashtag',
      {
        method: 'POST',
        body: apiBody<'/api/channels/bulk-hashtag', 'post'>({
          channel_names: channelNames,
          try_historical: tryHistorical,
        }),
      }
    ),
  deleteChannel: (key: string) =>
    fetchApi<'/api/channels/{key}', 'delete'>(`/channels/${key}`, { method: 'DELETE' }),
  getChannelDetail: (key: string) =>
    fetchApiView<'/api/channels/{key}/detail', 'get', ChannelDetail>(`/channels/${key}/detail`),
  markChannelRead: (
    key: string,
    messageId?: ApiQuery<'/api/channels/{key}/mark-read', 'post'>['message_id']
  ) =>
    fetchApi<'/api/channels/{key}/mark-read', 'post'>(
      `/channels/${key}/mark-read${messageId === undefined ? '' : `?message_id=${messageId}`}`,
      { method: 'POST' }
    ),
  setChannelFloodScopeOverride: (key: string, floodScopeOverride: string) =>
    fetchApiView<'/api/channels/{key}/flood-scope-override', 'post', Channel>(
      `/channels/${key}/flood-scope-override`,
      {
        method: 'POST',
        body: apiBody<'/api/channels/{key}/flood-scope-override', 'post'>({
          flood_scope_override: floodScopeOverride,
        }),
      }
    ),

  setChannelPathHashModeOverride: (key: string, pathHashModeOverride: number | null) =>
    fetchApiView<'/api/channels/{key}/path-hash-mode-override', 'post', Channel>(
      `/channels/${key}/path-hash-mode-override`,
      {
        method: 'POST',
        body: apiBody<'/api/channels/{key}/path-hash-mode-override', 'post'>({
          path_hash_mode_override: pathHashModeOverride,
        }),
      }
    ),

  // Messages
  getMessages: (
    params?: ApiQuery<'/api/messages', 'get'>,
    signal?: AbortSignal
  ): Promise<Message[]> => {
    const searchParams = new URLSearchParams();
    if (params?.limit !== undefined) searchParams.set('limit', params.limit.toString());
    if (params?.offset !== undefined) searchParams.set('offset', params.offset.toString());
    if (params?.type) searchParams.set('type', params.type);
    if (params?.conversation_key) searchParams.set('conversation_key', params.conversation_key);
    if (params?.before != null) searchParams.set('before', params.before.toString());
    if (params?.before_id != null) searchParams.set('before_id', params.before_id.toString());
    if (params?.after != null) searchParams.set('after', params.after.toString());
    if (params?.after_id != null) searchParams.set('after_id', params.after_id.toString());
    if (params?.q) searchParams.set('q', params.q);
    const query = searchParams.toString();
    return fetchApiView<'/api/messages', 'get', RestMessage[]>(
      `/messages${query ? `?${query}` : ''}`,
      { signal }
    );
  },
  getMessagesAround: (
    messageId: ApiPathParams<'/api/messages/around/{message_id}', 'get'>['message_id'],
    type?: ApiQuery<'/api/messages/around/{message_id}', 'get'>['type'],
    conversationKey?: ApiQuery<'/api/messages/around/{message_id}', 'get'>['conversation_key'],
    signal?: AbortSignal
  ) => {
    const searchParams = new URLSearchParams();
    if (type) searchParams.set('type', type);
    if (conversationKey) searchParams.set('conversation_key', conversationKey);
    const query = searchParams.toString();
    return fetchApiView<'/api/messages/around/{message_id}', 'get', MessagesAroundResponse>(
      `/messages/around/${messageId}${query ? `?${query}` : ''}`,
      { signal }
    );
  },
  sendDirectMessage: (
    destination: SendDirectMessageBody['destination'],
    text: SendDirectMessageBody['text']
  ) =>
    fetchApiView<'/api/messages/direct', 'post', Message>('/messages/direct', {
      method: 'POST',
      body: jsonBody<SendDirectMessageBody>({ destination, text }),
    }),
  sendChannelMessage: (
    channelKey: SendChannelMessageBody['channel_key'],
    text: SendChannelMessageBody['text']
  ) =>
    fetchApiView<'/api/messages/channel', 'post', Message>('/messages/channel', {
      method: 'POST',
      body: jsonBody<SendChannelMessageBody>({ channel_key: channelKey, text }),
    }),
  resendChannelMessage: (
    messageId: ApiPathParams<'/api/messages/channel/{message_id}/resend', 'post'>['message_id'],
    newTimestamp?: ApiQuery<'/api/messages/channel/{message_id}/resend', 'post'>['new_timestamp']
  ) =>
    fetchApiView<'/api/messages/channel/{message_id}/resend', 'post', ResendChannelMessageResponse>(
      `/messages/channel/${messageId}/resend${newTimestamp ? '?new_timestamp=true' : ''}`,
      { method: 'POST' }
    ),

  // Packets
  getPacket: (packetId: number) =>
    fetchApiView<'/api/packets/{packet_id}', 'get', RawPacket>(`/packets/${packetId}`),
  getUndecryptedPacketCount: () =>
    fetchApiView<'/api/packets/undecrypted/count', 'get', { count: number }>(
      '/packets/undecrypted/count'
    ),
  decryptHistoricalPackets: (params: ApiRequestBody<'/api/packets/decrypt/historical', 'post'>) =>
    fetchApiView<'/api/packets/decrypt/historical', 'post', DecryptResult>(
      '/packets/decrypt/historical',
      {
        method: 'POST',
        body: apiBody<'/api/packets/decrypt/historical', 'post'>(params),
      }
    ),
  runMaintenance: (options: { pruneUndecryptedDays?: number; purgeLinkedRawPackets?: boolean }) =>
    fetchApiView<'/api/packets/maintenance', 'post', MaintenanceResult>('/packets/maintenance', {
      method: 'POST',
      body: apiBody<'/api/packets/maintenance', 'post'>({
        ...(options.pruneUndecryptedDays !== undefined && {
          prune_undecrypted_days: options.pruneUndecryptedDays,
        }),
        purge_linked_raw_packets: options.purgeLinkedRawPackets ?? false,
      }),
    }),

  // Read State
  getUnreads: () =>
    fetchApiView<'/api/read-state/unreads', 'get', UnreadCounts>('/read-state/unreads'),
  markAllRead: () =>
    fetchApi<'/api/read-state/mark-all-read', 'post'>('/read-state/mark-all-read', {
      method: 'POST',
    }),

  // App Settings
  getSettings: (signal?: AbortSignal) =>
    fetchApiView<'/api/settings', 'get', AppSettings>('/settings', { signal }),
  updateSettings: (settings: AppSettingsUpdate & UpdateSettingsBody) =>
    fetchApiView<'/api/settings', 'patch', AppSettings>('/settings', {
      method: 'PATCH',
      body: jsonBody<UpdateSettingsBody>(settings),
    }),

  // Block lists
  toggleBlockedKey: (key: string) =>
    fetchApiView<'/api/settings/blocked-keys/toggle', 'post', AppSettings>(
      '/settings/blocked-keys/toggle',
      {
        method: 'POST',
        body: apiBody<'/api/settings/blocked-keys/toggle', 'post'>({ key }),
      }
    ),
  toggleBlockedName: (name: string) =>
    fetchApiView<'/api/settings/blocked-names/toggle', 'post', AppSettings>(
      '/settings/blocked-names/toggle',
      {
        method: 'POST',
        body: apiBody<'/api/settings/blocked-names/toggle', 'post'>({ name }),
      }
    ),

  // Tracked telemetry
  toggleTrackedTelemetry: (publicKey: string) =>
    fetchApiView<'/api/settings/tracked-telemetry/toggle', 'post', TrackedTelemetryResponse>(
      '/settings/tracked-telemetry/toggle',
      {
        method: 'POST',
        body: apiBody<'/api/settings/tracked-telemetry/toggle', 'post'>({
          public_key: publicKey,
        }),
      }
    ),

  getTelemetrySchedule: () =>
    fetchApiView<'/api/settings/tracked-telemetry/schedule', 'get', TelemetrySchedule>(
      '/settings/tracked-telemetry/schedule'
    ),

  // Tracked contact telemetry
  toggleTrackedTelemetryContact: (publicKey: string) =>
    fetchApiView<
      '/api/settings/tracked-telemetry-contacts/toggle',
      'post',
      TrackedTelemetryContactsResponse
    >('/settings/tracked-telemetry-contacts/toggle', {
      method: 'POST',
      body: apiBody<'/api/settings/tracked-telemetry-contacts/toggle', 'post'>({
        public_key: publicKey,
      }),
    }),

  getContactTelemetrySchedule: () =>
    fetchApiView<'/api/settings/tracked-telemetry-contacts/schedule', 'get', TelemetrySchedule>(
      '/settings/tracked-telemetry-contacts/schedule'
    ),

  // Favorites
  toggleFavorite: (type: 'channel' | 'contact', id: string) =>
    fetchApi<'/api/settings/favorites/toggle', 'post'>('/settings/favorites/toggle', {
      method: 'POST',
      body: apiBody<'/api/settings/favorites/toggle', 'post'>({ type, id }),
    }),

  toggleChannelMute: (key: string) =>
    fetchApi<'/api/settings/muted-channels/toggle', 'post'>('/settings/muted-channels/toggle', {
      method: 'POST',
      body: apiBody<'/api/settings/muted-channels/toggle', 'post'>({ key }),
    }),

  // Fanout
  getFanoutConfigs: () => fetchApiView<'/api/fanout', 'get', FanoutConfig[]>('/fanout'),
  createFanoutConfig: (config: ApiRequestBody<'/api/fanout', 'post'>) =>
    fetchApiView<'/api/fanout', 'post', FanoutConfig>('/fanout', {
      method: 'POST',
      body: apiBody<'/api/fanout', 'post'>(config),
    }),
  updateFanoutConfig: (id: string, update: ApiRequestBody<'/api/fanout/{config_id}', 'patch'>) =>
    fetchApiView<'/api/fanout/{config_id}', 'patch', FanoutConfig>(`/fanout/${id}`, {
      method: 'PATCH',
      body: apiBody<'/api/fanout/{config_id}', 'patch'>(update),
    }),
  deleteFanoutConfig: (id: string) =>
    fetchApi<'/api/fanout/{config_id}', 'delete'>(`/fanout/${id}`, {
      method: 'DELETE',
    }),
  disableBotsUntilRestart: () =>
    fetchApi<'/api/fanout/bots/disable-until-restart', 'post'>(
      '/fanout/bots/disable-until-restart',
      {
        method: 'POST',
      }
    ),

  // Statistics
  getStatistics: () => fetchApiView<'/api/statistics', 'get', StatisticsResponse>('/statistics'),

  // Granular repeater endpoints
  repeaterLogin: (publicKey: string, password: string) =>
    fetchApiView<'/api/contacts/{public_key}/repeater/login', 'post', RepeaterLoginResponse>(
      `/contacts/${publicKey}/repeater/login`,
      {
        method: 'POST',
        body: apiBody<'/api/contacts/{public_key}/repeater/login', 'post'>({ password }),
      }
    ),
  repeaterStatus: (publicKey: string) =>
    fetchApiLooseView<'/api/contacts/{public_key}/repeater/status', 'post', RepeaterStatusResponse>(
      `/contacts/${publicKey}/repeater/status`,
      { method: 'POST' }
    ),
  repeaterNeighbors: (publicKey: string) =>
    fetchApiView<
      '/api/contacts/{public_key}/repeater/neighbors',
      'post',
      RepeaterNeighborsResponse
    >(`/contacts/${publicKey}/repeater/neighbors`, { method: 'POST' }),
  repeaterNodeInfo: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/repeater/node-info', 'post', RepeaterNodeInfoResponse>(
      `/contacts/${publicKey}/repeater/node-info`,
      { method: 'POST' }
    ),
  repeaterAcl: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/repeater/acl', 'post', RepeaterAclResponse>(
      `/contacts/${publicKey}/repeater/acl`,
      { method: 'POST' }
    ),
  repeaterRadioSettings: (publicKey: string) =>
    fetchApiView<
      '/api/contacts/{public_key}/repeater/radio-settings',
      'post',
      RepeaterRadioSettingsResponse
    >(`/contacts/${publicKey}/repeater/radio-settings`, { method: 'POST' }),
  repeaterAdvertIntervals: (publicKey: string) =>
    fetchApiView<
      '/api/contacts/{public_key}/repeater/advert-intervals',
      'post',
      RepeaterAdvertIntervalsResponse
    >(`/contacts/${publicKey}/repeater/advert-intervals`, { method: 'POST' }),
  repeaterOwnerInfo: (publicKey: string) =>
    fetchApiView<
      '/api/contacts/{public_key}/repeater/owner-info',
      'post',
      RepeaterOwnerInfoResponse
    >(`/contacts/${publicKey}/repeater/owner-info`, { method: 'POST' }),
  repeaterRegions: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/repeater/regions', 'post', RepeaterRegionsResponse>(
      `/contacts/${publicKey}/repeater/regions`,
      { method: 'POST' }
    ),
  repeaterLppTelemetry: (publicKey: string) =>
    fetchApiLooseView<
      '/api/contacts/{public_key}/repeater/lpp-telemetry',
      'post',
      RepeaterLppTelemetryResponse
    >(`/contacts/${publicKey}/repeater/lpp-telemetry`, { method: 'POST' }),
  repeaterTelemetryHistory: (publicKey: string) =>
    fetchApiLooseView<
      '/api/contacts/{public_key}/repeater/telemetry-history',
      'get',
      TelemetryHistoryEntry[]
    >(`/contacts/${publicKey}/repeater/telemetry-history`),
  // Contact telemetry (universal, any contact type)
  requestContactTelemetry: (publicKey: string) =>
    fetchApiLooseView<'/api/contacts/{public_key}/telemetry', 'post', ContactTelemetryResponse>(
      `/contacts/${publicKey}/telemetry`,
      { method: 'POST' }
    ),
  contactTelemetryHistory: (publicKey: string) =>
    fetchApiLooseView<
      '/api/contacts/{public_key}/telemetry-history',
      'get',
      TelemetryHistoryEntry[]
    >(`/contacts/${publicKey}/telemetry-history`),
  roomLogin: (publicKey: string, password: string) =>
    fetchApiView<'/api/contacts/{public_key}/room/login', 'post', RepeaterLoginResponse>(
      `/contacts/${publicKey}/room/login`,
      {
        method: 'POST',
        body: apiBody<'/api/contacts/{public_key}/room/login', 'post'>({ password }),
      }
    ),
  roomStatus: (publicKey: string) =>
    fetchApiLooseView<'/api/contacts/{public_key}/room/status', 'post', RepeaterStatusResponse>(
      `/contacts/${publicKey}/room/status`,
      { method: 'POST' }
    ),
  roomAcl: (publicKey: string) =>
    fetchApiView<'/api/contacts/{public_key}/room/acl', 'post', RepeaterAclResponse>(
      `/contacts/${publicKey}/room/acl`,
      { method: 'POST' }
    ),
  roomLppTelemetry: (publicKey: string) =>
    fetchApiLooseView<
      '/api/contacts/{public_key}/room/lpp-telemetry',
      'post',
      RepeaterLppTelemetryResponse
    >(`/contacts/${publicKey}/room/lpp-telemetry`, { method: 'POST' }),

  // Push Notifications
  getVapidPublicKey: () => fetchApi<'/api/push/vapid-public-key', 'get'>('/push/vapid-public-key'),
  pushSubscribe: (subscription: ApiRequestBody<'/api/push/subscribe', 'post'>) =>
    fetchApiView<'/api/push/subscribe', 'post', PushSubscriptionInfo>('/push/subscribe', {
      method: 'POST',
      body: apiBody<'/api/push/subscribe', 'post'>(subscription),
    }),
  getPushSubscriptions: () =>
    fetchApiView<'/api/push/subscriptions', 'get', PushSubscriptionInfo[]>('/push/subscriptions'),
  deletePushSubscription: (id: string) =>
    fetchApi<'/api/push/subscriptions/{subscription_id}', 'delete'>(`/push/subscriptions/${id}`, {
      method: 'DELETE',
    }),
  testPushSubscription: (id: string) =>
    fetchApi<'/api/push/subscriptions/{subscription_id}/test', 'post'>(
      `/push/subscriptions/${id}/test`,
      { method: 'POST' }
    ),
  getPushConversations: () => fetchApi<'/api/push/conversations', 'get'>('/push/conversations'),
  togglePushConversation: (key: string) =>
    fetchApi<'/api/push/conversations/toggle', 'post'>('/push/conversations/toggle', {
      method: 'POST',
      body: apiBody<'/api/push/conversations/toggle', 'post'>({ key }),
    }),
};
