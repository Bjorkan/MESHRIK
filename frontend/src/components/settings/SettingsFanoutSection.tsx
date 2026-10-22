import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { getLocale } from '@/i18n';
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useStore } from '@tanstack/react-form';
import { ChevronDown, Info } from 'lucide-react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { toast } from '../ui/sonner';
import { cn } from '@/lib/utils';
import { api } from '../../api';
import { fetchAllContacts } from '../../hooks/useContactsAndChannels';
import { queryKeys } from '../../queryClient';
import type { FanoutConfig, HealthStatus } from '../../types';
import communityPresets from '../../config/community_presets.json';

const BotCodeEditor = lazy(() =>
  import('../BotCodeEditor').then((m) => ({ default: m.BotCodeEditor }))
);

const FANOUT_CONFIGS_QUERY_KEY = ['fanout', 'configs'] as const;

const TYPE_LABELS: Record<string, string> = {
  virtual_companion_tcp: 'MeshCore App (Virtual TCP Companion)',
  mqtt_private: 'Private MQTT',
  mqtt_community: 'Community Sharing',
  mqtt_ha: 'Home Assistant',
  bot: 'Python Bot',
  webhook: 'Webhook',
  apprise: 'Apprise',
  sqs: 'Amazon SQS',
  map_upload: 'Map Upload',
};

const DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE = 'meshcore/{IATA}/{PUBLIC_KEY}/packets';
const DEFAULT_COMMUNITY_BROKER_HOST = 'mqtt-us-v1.letsmesh.net';
const DEFAULT_COMMUNITY_BROKER_HOST_EU = 'mqtt-eu-v1.letsmesh.net';
const DEFAULT_COMMUNITY_BROKER_PORT = 443;
const DEFAULT_COMMUNITY_TRANSPORT = 'websockets';
const DEFAULT_COMMUNITY_WEBSOCKET_PATH = '/';
const DEFAULT_COMMUNITY_AUTH_MODE = 'token';
const DEFAULT_MESHRANK_BROKER_HOST = 'meshrank.net';
const DEFAULT_MESHRANK_BROKER_PORT = 8883;
const DEFAULT_MESHRANK_TRANSPORT = 'tcp';
const DEFAULT_MESHRANK_AUTH_MODE = 'none';
const EMPTY_TRACKED_KEYS: string[] = [];

function createCommunityConfigDefaults(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    broker_host: DEFAULT_COMMUNITY_BROKER_HOST,
    broker_port: DEFAULT_COMMUNITY_BROKER_PORT,
    transport: DEFAULT_COMMUNITY_TRANSPORT,
    websocket_path: DEFAULT_COMMUNITY_WEBSOCKET_PATH,
    _websocket_path_source: 'default',
    use_tls: true,
    tls_verify: true,
    auth_mode: DEFAULT_COMMUNITY_AUTH_MODE,
    username: '',
    password: '',
    iata: '',
    email: '',
    token_audience: '',
    topic_template: DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE,
    ...overrides,
  };
}

const DEFAULT_BOT_CODE = `def bot(**kwargs) -> str | list[str] | None:
    """
    Process messages and optionally return a reply.

    Args:
        kwargs keys currently provided:
            sender_name: Display name of sender (may be None)
            sender_key: 64-char hex public key (None for channel msgs)
            message_text: The message content
            is_dm: True for direct messages, False for channel
            channel_key: 32-char hex key for channels, None for DMs
            channel_name: Channel name with hash (e.g. "#bot"), None for DMs
            sender_timestamp: Sender's timestamp (unix seconds, may be None)
            path: Hex-encoded routing path (may be None)
            is_outgoing: True if this is our own outgoing message
            path_bytes_per_hop: Bytes per hop in path (1, 2, or 3) when known
            scoped: True if the message carried a regional flood scope,
                False for plain/unscoped flood. Check this first. Set for
                scoped DMs too.
            region: Only meaningful when scoped is True (else always None).
                When scoped, it's the decoded region name, or None if the
                scope matched none of your known_regions. region alone can't
                distinguish unscoped from unrecognized — use scoped.

    Returns:
        None for no reply, a string for a single reply,
        a list of strings to send multiple messages in order, or a dict
        {"region": <name or None>, "message": <str or list[str]>} to scope a
        channel reply to a region for that send only (None/"" = unscoped flood;
        region is ignored for DM replies).
    """
    sender_name = kwargs.get("sender_name")
    message_text = kwargs.get("message_text", "")
    channel_name = kwargs.get("channel_name")
    is_outgoing = kwargs.get("is_outgoing", False)
    path_bytes_per_hop = kwargs.get("path_bytes_per_hop")

    # Don't reply to our own outgoing messages
    if is_outgoing:
        return None
    
    # If you want to make use of persistant data between calls to this function, 
    # you can put that data into the global _bot_globals dictionary, e.g.:
    #
    # bot_globals = globals()["_bot_globals"] 
    # if not "known_sender_names" in bot_globals:
    #     bot_globals["known_sender_names"] = set()
    #
    # bot_globals["known_sender_names"].add(sender_name)

    # Example: Only respond in #bot channel to "!pling" command
    if channel_name == "#bot" and "!pling" in message_text.lower():
        return "[BOT] Plong!"
    return None`;

type DraftType =
  | 'virtual_companion_tcp'
  | 'mqtt_private'
  | 'mqtt_ha'
  | 'mqtt_community'
  | 'mqtt_community_meshrank'
  | 'mqtt_community_letsmesh_us'
  | 'mqtt_community_letsmesh_eu'
  | 'webhook'
  | 'apprise'
  | 'sqs'
  | 'bot'
  | 'map_upload';

type CreateIntegrationDefinition = {
  value: DraftType;
  savedType: string;
  label: string;
  section: string;
  description: string;
  defaultName: string;
  nameMode: 'counted' | 'fixed';
  defaultEnabled?: boolean;
  defaults: {
    config: Record<string, unknown>;
    scope: Record<string, unknown>;
  };
};

const CREATE_INTEGRATION_DEFINITIONS: readonly CreateIntegrationDefinition[] = [
  {
    value: 'virtual_companion_tcp',
    savedType: 'virtual_companion_tcp',
    get label() {
      return t`MeshCore App (Virtual TCP Companion)`;
    },
    section: 'MeshCore Apps',
    get description() {
      return t`Let the official MeshCore app use MESHRIK's shared node and DB through a separate virtual TCP listener. This is not the physical radio's TCP endpoint and does not provide full firmware administration.`;
    },
    defaultName: 'MeshCore App',
    nameMode: 'fixed',
    defaultEnabled: false,
    defaults: {
      config: {
        bind_host: '0.0.0.0',
        port: 5000,
        unsafe_network_acknowledged: false,
        secure_access: '',
        virtual_channel_capacity: 40,
        channel_slots: [],
      },
      scope: { messages: 'none', raw_packets: 'none' },
    },
  },
  {
    value: 'mqtt_private',
    savedType: 'mqtt_private',
    get label() {
      return t`Private MQTT`;
    },
    section: 'Private Forwarding',
    get description() {
      return t`Customizable-scope forwarding of all or some messages to an MQTT broker of your choosing, in raw and/or decrypted form.`;
    },
    defaultName: 'Private MQTT',
    nameMode: 'counted',
    defaults: {
      config: {
        broker_host: '',
        broker_port: 1883,
        username: '',
        password: '',
        use_tls: false,
        tls_insecure: false,
        topic_prefix: 'meshcore',
      },
      scope: { messages: 'all', raw_packets: 'all' },
    },
  },
  {
    value: 'mqtt_ha',
    savedType: 'mqtt_ha',
    get label() {
      return t`Home Assistant MQTT Discovery`;
    },
    section: 'Private Forwarding',
    get description() {
      return t`Publishes MQTT Discovery payloads so mesh devices appear natively in Home Assistant. Requires HA's built-in MQTT integration connected to the same broker. Select specific contacts for GPS tracking and repeaters for telemetry sensors.`;
    },
    defaultName: 'Home Assistant',
    nameMode: 'fixed',
    defaults: {
      config: {
        broker_host: '',
        broker_port: 1883,
        username: '',
        password: '',
        use_tls: false,
        tls_insecure: false,
        topic_prefix: 'meshcore',
        tracked_contacts: [],
        tracked_repeaters: [],
      },
      scope: { messages: 'all', raw_packets: 'none' },
    },
  },
  {
    value: 'mqtt_community',
    savedType: 'mqtt_community',
    get label() {
      return t`Community MQTT/meshcoretomqtt`;
    },
    section: 'Community Sharing',
    get description() {
      return t`MeshcoreToMQTT-compatible raw-packet feed publishing, compatible with community aggregators (in other words, make your companion radio also serve as an observer node). Superset of other Community MQTT presets.`;
    },
    defaultName: 'Community MQTT',
    nameMode: 'counted',
    defaults: {
      config: createCommunityConfigDefaults(),
      scope: { messages: 'none', raw_packets: 'all' },
    },
  },
  {
    value: 'mqtt_community_meshrank',
    savedType: 'mqtt_community',
    get label() {
      return t`MeshRank`;
    },
    section: 'Community Sharing',
    get description() {
      return t`A community MQTT config preconfigured for MeshRank, requiring only your MeshRank uplink token. A subset of the primary Community MQTT/meshcoretomqtt configuration; you are free to edit all configuration after creation.`;
    },
    defaultName: 'MeshRank',
    nameMode: 'fixed',
    defaults: {
      config: createCommunityConfigDefaults({
        broker_host: DEFAULT_MESHRANK_BROKER_HOST,
        broker_port: DEFAULT_MESHRANK_BROKER_PORT,
        transport: DEFAULT_MESHRANK_TRANSPORT,
        auth_mode: DEFAULT_MESHRANK_AUTH_MODE,
        profile: 'meshrank',
        token: '',
        iata: '',
        email: '',
        token_audience: '',
        topic_template: '',
      }),
      scope: { messages: 'none', raw_packets: 'all' },
    },
  },
  {
    value: 'mqtt_community_letsmesh_us',
    savedType: 'mqtt_community',
    get label() {
      return t`LetsMesh (US)`;
    },
    section: 'Community Sharing',
    get description() {
      return t`A community MQTT config preconfigured for the LetsMesh US-ingest endpoint, requiring only your email and IATA region code. Good to use with an additional EU configuration for redundancy. A subset of the primary Community MQTT/meshcoretomqtt configuration; you are free to edit all configuration after creation.`;
    },
    defaultName: 'LetsMesh (US)',
    nameMode: 'fixed',
    defaults: {
      config: createCommunityConfigDefaults({
        broker_host: DEFAULT_COMMUNITY_BROKER_HOST,
        token_audience: DEFAULT_COMMUNITY_BROKER_HOST,
      }),
      scope: { messages: 'none', raw_packets: 'all' },
    },
  },
  {
    value: 'mqtt_community_letsmesh_eu',
    savedType: 'mqtt_community',
    get label() {
      return t`LetsMesh (EU)`;
    },
    section: 'Community Sharing',
    get description() {
      return t`A community MQTT config preconfigured for the LetsMesh EU-ingest endpoint, requiring only your email and IATA region code. Good to use with an additional US configuration for redundancy. A subset of the primary Community MQTT/meshcoretomqtt configuration; you are free to edit all configuration after creation.`;
    },
    defaultName: 'LetsMesh (EU)',
    nameMode: 'fixed',
    defaults: {
      config: createCommunityConfigDefaults({
        broker_host: DEFAULT_COMMUNITY_BROKER_HOST_EU,
        token_audience: DEFAULT_COMMUNITY_BROKER_HOST_EU,
      }),
      scope: { messages: 'none', raw_packets: 'all' },
    },
  },
  {
    value: 'webhook',
    savedType: 'webhook',
    get label() {
      return t`Webhook`;
    },
    section: 'Automation',
    get description() {
      return t`Generic webhook for decrypted channel/DM messages with customizable verb, method, and optional HMAC signature.`;
    },
    defaultName: 'Webhook',
    nameMode: 'counted',
    defaults: {
      config: {
        url: '',
        method: 'POST',
        headers: {},
        hmac_secret: '',
        hmac_header: '',
      },
      scope: { messages: 'all', raw_packets: 'none' },
    },
  },
  {
    value: 'apprise',
    savedType: 'apprise',
    get label() {
      return t`Apprise`;
    },
    section: 'Automation',
    get description() {
      return t`A wide-ranging generic fanout, capable of forwarding decrypted channel/DM messages to Discord, Telegram, email, SMS, and many others.`;
    },
    defaultName: 'Apprise',
    nameMode: 'counted',
    defaults: {
      config: {
        urls: '',
        preserve_identity: true,
        include_outgoing: false,
        markdown_format: true,
        body_format_dm: '**DM:** {sender_name}: {text} **via:** [{hops_backticked}]',
        body_format_channel:
          '**{channel_name}:** {sender_name}: {text} **via:** [{hops_backticked}]',
      },
      scope: { messages: 'all', raw_packets: 'none' },
    },
  },
  {
    value: 'sqs',
    savedType: 'sqs',
    get label() {
      return t`Amazon SQS`;
    },
    section: 'Private Forwarding',
    get description() {
      return t`Send full or scope-customized raw or decrypted packets to an SQS`;
    },
    defaultName: 'Amazon SQS',
    nameMode: 'counted',
    defaults: {
      config: {
        queue_url: '',
        region_name: '',
        endpoint_url: '',
        access_key_id: '',
        secret_access_key: '',
        session_token: '',
      },
      scope: { messages: 'all', raw_packets: 'none' },
    },
  },
  {
    value: 'bot',
    savedType: 'bot',
    get label() {
      return t`Python Bot`;
    },
    section: 'Automation',
    get description() {
      return t`A simple, Python-based interface for basic bots that can respond to DM and channel messages.`;
    },
    defaultName: 'Bot',
    nameMode: 'counted',
    defaults: {
      config: {
        code: DEFAULT_BOT_CODE,
      },
      scope: { messages: 'all', raw_packets: 'none' },
    },
  },
  {
    value: 'map_upload',
    savedType: 'map_upload',
    get label() {
      return t`Map Upload`;
    },
    section: 'Community Sharing',
    get description() {
      return t`Upload repeaters and room servers to map.meshcore.io or a compatible map API endpoint.`;
    },
    defaultName: 'Map Upload',
    nameMode: 'counted',
    defaults: {
      config: {
        api_url: '',
        dry_run: true,
      },
      scope: { messages: 'none', raw_packets: 'all' },
    },
  },
];

const CREATE_INTEGRATION_DEFINITIONS_BY_VALUE = Object.fromEntries(
  CREATE_INTEGRATION_DEFINITIONS.map((definition) => [definition.value, definition])
) as Record<DraftType, CreateIntegrationDefinition>;

function getNumberInputValue(value: unknown, fallback: number): string | number {
  if (value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function getOptionalNumberInputValue(value: unknown): string | number {
  if (value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return '';
}

function parseIntegerInputValue(value: string): number | string {
  if (value === '') return '';
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? value : parsed;
}

function parseFloatInputValue(value: string): number | string {
  if (value === '') return '';
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? value : parsed;
}

function normalizeIntegrationConfigForSave(
  configType: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...config };

  if (configType === 'mqtt_private') {
    const port = normalized.broker_port;
    if (port === '' || port === undefined || port === null) {
      normalized.broker_port = 1883;
    } else if (typeof port === 'string') {
      const parsed = Number.parseInt(port, 10);
      normalized.broker_port = Number.isNaN(parsed) ? 1883 : parsed;
    }

    const topicPrefix = String(normalized.topic_prefix ?? '').trim();
    normalized.topic_prefix = topicPrefix || 'meshcore';
  }

  if (configType === 'mqtt_community') {
    const brokerHost = String(normalized.broker_host ?? '').trim();
    normalized.broker_host = brokerHost || DEFAULT_COMMUNITY_BROKER_HOST;

    const port = normalized.broker_port;
    if (port === '' || port === undefined || port === null) {
      normalized.broker_port = DEFAULT_COMMUNITY_BROKER_PORT;
    } else if (typeof port === 'string') {
      const parsed = Number.parseInt(port, 10);
      normalized.broker_port = Number.isNaN(parsed) ? DEFAULT_COMMUNITY_BROKER_PORT : parsed;
    }

    const topicTemplate = String(normalized.topic_template ?? '').trim();
    normalized.topic_template =
      normalized.profile === 'meshrank'
        ? topicTemplate
        : topicTemplate || DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE;

    if (normalized.transport === 'websockets') {
      normalized.websocket_path = normalizeCommunityWebsocketPath(normalized.websocket_path);
    }
    if (!normalized.preset) delete normalized.preset;
    delete normalized._websocket_path_source;
  }

  if (configType === 'map_upload') {
    const radius = normalized.geofence_radius_km;
    if (radius === '' || radius === undefined || radius === null) {
      normalized.geofence_radius_km = 0;
    } else if (typeof radius === 'string') {
      const parsed = Number.parseFloat(radius);
      normalized.geofence_radius_km = Number.isNaN(parsed) ? 0 : parsed;
    }
  }

  if (configType === 'virtual_companion_tcp') {
    const bindHost = String(normalized.bind_host ?? '')
      .trim()
      .toLowerCase();
    const secureAccess = String(normalized.secure_access ?? '');
    if (!bindHost && secureAccess) {
      throw new Error(t`A protected literal bind address is required for remote access`);
    }
    normalized.bind_host = bindHost === 'localhost' ? '127.0.0.1' : bindHost || '0.0.0.0';
    const trustedLan = normalized.bind_host === '0.0.0.0' && !secureAccess;
    if (!trustedLan && !isVirtualLoopbackHost(String(normalized.bind_host))) {
      if (!isLiteralIpAddress(String(normalized.bind_host))) {
        throw new Error(t`Remote bind address must be a literal IPv4 or IPv6 address`);
      }
      if (
        normalized.unsafe_network_acknowledged !== true ||
        !['vpn', 'mtls_proxy'].includes(secureAccess)
      ) {
        throw new Error(t`Confirm a protected VPN or mTLS proxy before enabling remote access`);
      }
    } else {
      normalized.unsafe_network_acknowledged = false;
      normalized.secure_access = '';
    }
    const port = normalized.port;
    const parsedPort = typeof port === 'string' ? Number(port) : port;
    if (!Number.isInteger(parsedPort) || Number(parsedPort) < 1 || Number(parsedPort) > 65535) {
      throw new Error(t`Virtual TCP port must be an integer between 1 and 65535`);
    }
    normalized.port = parsedPort;
    const capacity = normalized.virtual_channel_capacity;
    const parsedCapacity = typeof capacity === 'string' ? Number(capacity) : capacity;
    if (
      !Number.isInteger(parsedCapacity) ||
      Number(parsedCapacity) < 1 ||
      Number(parsedCapacity) > 255
    ) {
      throw new Error(t`Virtual channel capacity must be an integer between 1 and 255`);
    }
    normalized.virtual_channel_capacity = parsedCapacity;
    const slots = normalized.channel_slots;
    if (!Array.isArray(slots) || slots.length > Number(parsedCapacity)) {
      throw new Error(t`Virtual channel selection exceeds the configured slot capacity`);
    }
  }

  return normalized;
}

function normalizeCommunityWebsocketPath(value: unknown): string {
  const path = String(value ?? '').trim();
  if (!path) return DEFAULT_COMMUNITY_WEBSOCKET_PATH;
  if (!path.startsWith('/') || /\s|[?#]/.test(path)) {
    throw new Error(t`WebSocket Path must start with / and contain no spaces, ? or #`);
  }
  return path;
}

function getCommunityWebsocketPathError(value: unknown): string | null {
  try {
    normalizeCommunityWebsocketPath(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid WebSocket Path';
  }
}

function isDraftType(value: string): value is DraftType {
  return value in CREATE_INTEGRATION_DEFINITIONS_BY_VALUE;
}

function getCreateIntegrationDefinition(draftType: DraftType) {
  return CREATE_INTEGRATION_DEFINITIONS_BY_VALUE[draftType];
}

function normalizeDraftName(draftType: DraftType, name: string, configs: FanoutConfig[]) {
  const definition = getCreateIntegrationDefinition(draftType);
  if (name) return name;
  if (definition.nameMode === 'fixed') return definition.defaultName;
  return getDefaultIntegrationName(definition.savedType, configs);
}

function normalizeDraftConfig(draftType: DraftType, config: Record<string, unknown>) {
  if (draftType === 'mqtt_community_meshrank') {
    const token = String(config.token || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
      throw new Error(t`A valid MeshRank uplink token (8–128 URL-safe characters) is required`);
    }
    return normalizeIntegrationConfigForSave('mqtt_community', {
      ...config,
      profile: 'meshrank',
      token,
      broker_host: DEFAULT_MESHRANK_BROKER_HOST,
      broker_port: DEFAULT_MESHRANK_BROKER_PORT,
      transport: DEFAULT_MESHRANK_TRANSPORT,
      auth_mode: DEFAULT_MESHRANK_AUTH_MODE,
      use_tls: true,
      tls_verify: true,
      iata: '',
      email: '',
      token_audience: '',
      topic_template: '',
      username: '',
      password: '',
    });
  }

  if (draftType === 'mqtt_community_letsmesh_us' || draftType === 'mqtt_community_letsmesh_eu') {
    const brokerHost =
      draftType === 'mqtt_community_letsmesh_eu'
        ? DEFAULT_COMMUNITY_BROKER_HOST_EU
        : DEFAULT_COMMUNITY_BROKER_HOST;
    return normalizeIntegrationConfigForSave('mqtt_community', {
      ...config,
      broker_host: brokerHost,
      broker_port: DEFAULT_COMMUNITY_BROKER_PORT,
      transport: DEFAULT_COMMUNITY_TRANSPORT,
      auth_mode: DEFAULT_COMMUNITY_AUTH_MODE,
      use_tls: true,
      tls_verify: true,
      token_audience: brokerHost,
      topic_template: (config.topic_template as string) || DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE,
      username: '',
      password: '',
    });
  }

  return normalizeIntegrationConfigForSave(
    getCreateIntegrationDefinition(draftType).savedType,
    config
  );
}

function normalizeDraftScope(draftType: DraftType, scope: Record<string, unknown>) {
  if (draftType === 'virtual_companion_tcp') {
    return { messages: 'none', raw_packets: 'none' };
  }
  if (getCreateIntegrationDefinition(draftType).savedType === 'mqtt_community') {
    return { messages: 'none', raw_packets: 'all' };
  }
  return scope;
}

function cloneDraftDefaults(draftType: DraftType) {
  const recipe = getCreateIntegrationDefinition(draftType);
  return {
    config: structuredClone(recipe.defaults.config),
    scope: structuredClone(recipe.defaults.scope),
  };
}

function CreateIntegrationDialog({
  open,
  options,
  selectedType,
  onOpenChange,
  onSelect,
  onCreate,
}: {
  open: boolean;
  options: readonly CreateIntegrationDefinition[];
  selectedType: DraftType | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (type: DraftType) => void;
  onCreate: () => void;
}) {
  useLingui();

  const selectedOption =
    options.find((option) => option.value === selectedType) ?? options[0] ?? null;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [showScrollHint, setShowScrollHint] = useState(false);

  const updateScrollHint = useCallback(() => {
    const container = listRef.current;
    if (!container) {
      setShowScrollHint(false);
      return;
    }
    setShowScrollHint(container.scrollTop + container.clientHeight < container.scrollHeight - 8);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updateScrollHint);
    window.addEventListener('resize', updateScrollHint);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateScrollHint);
    };
  }, [open, options, updateScrollHint]);

  const sectionedOptions = [...new Set(options.map((o) => o.section))]
    .map((section) => ({
      section,
      options: options.filter((option) => option.section === section),
    }))
    .filter((group) => group.options.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        hideCloseButton
        className="flex max-h-[calc(100dvh-2rem)] w-[96vw] max-w-[960px] flex-col overflow-hidden p-0 sm:rounded-xl"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>
            <Trans>Create Integration</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="relative border-b border-border bg-muted/20 md:border-b-0 md:border-r">
            <div
              ref={listRef}
              onScroll={updateScrollHint}
              className="max-h-56 overflow-y-auto p-2 md:max-h-[420px]"
            >
              <div className="space-y-4">
                {sectionedOptions.map((group) => (
                  <div key={group.section} className="space-y-1.5">
                    <div className="px-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.section}
                    </div>
                    {group.options.map((option) => {
                      const selected = option.value === selectedOption?.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            'w-full rounded-md border px-3 py-2 text-left transition-colors',
                            selected
                              ? 'border-primary bg-accent text-foreground'
                              : 'border-transparent bg-transparent hover:bg-accent/70'
                          )}
                          aria-pressed={selected}
                          onClick={() => onSelect(option.value)}
                        >
                          <div className="text-sm font-medium">{option.label}</div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {showScrollHint && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/85 to-transparent px-4 pb-2 pt-8">
                <div className="rounded-full border border-border/80 bg-background/95 px-2 py-1 text-muted-foreground shadow-sm">
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
            )}
          </div>

          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-5 md:min-h-[280px] md:max-h-[420px]">
            {selectedOption ? (
              <>
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {selectedOption.section}
                  </div>
                  <h3 className="text-lg font-semibold">{selectedOption.label}</h3>
                </div>

                <p className="text-sm leading-6 text-muted-foreground">
                  {selectedOption.description}
                </p>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Trans>No integration types are currently available.</Trans>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-border px-5 py-4 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Close</Trans>
          </Button>
          <Button onClick={onCreate} disabled={!selectedOption}>
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getDetailTypeLabel(detailType: string) {
  if (isDraftType(detailType)) return getCreateIntegrationDefinition(detailType).label;
  return TYPE_LABELS[detailType] || detailType;
}

function fanoutDraftHasUnsavedChanges(
  original: FanoutConfig | null,
  current: {
    name: string;
    config: Record<string, unknown>;
    scope: Record<string, unknown>;
  }
) {
  if (!original) return false;
  return (
    current.name !== original.name ||
    JSON.stringify(current.config) !== JSON.stringify(original.config) ||
    JSON.stringify(current.scope) !== JSON.stringify(original.scope)
  );
}

function formatBrokerSummary(
  config: Record<string, unknown>,
  defaults: { host: string; port: number }
) {
  const host = (config.broker_host as string) || defaults.host;
  const port = typeof config.broker_port === 'number' ? config.broker_port : defaults.port;
  return `${host}:${port}`;
}

function formatPrivateTopicSummary(config: Record<string, unknown>) {
  const prefix = (config.topic_prefix as string) || 'meshcore';
  return `${prefix}/dm:<pubkey>, ${prefix}/gm:<channel>, ${prefix}/raw/...`;
}

function censorAppriseUrl(url: string): string {
  const protoMatch = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (protoMatch) return `${protoMatch[0]}********`;
  return '********';
}

function formatAppriseTargets(urls: string | undefined) {
  const targets = (urls || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (targets.length === 0) return 'No targets configured';

  return targets.map(censorAppriseUrl).join(', ');
}

function formatSqsQueueSummary(config: Record<string, unknown>) {
  const queueUrl = ((config.queue_url as string) || '').trim();
  if (!queueUrl) return 'No queue configured';
  return queueUrl;
}

function getDefaultIntegrationName(type: string, configs: FanoutConfig[]) {
  const label = TYPE_LABELS[type] || type;
  const nextIndex = configs.filter((cfg) => cfg.type === type).length + 1;
  return `${label} #${nextIndex}`;
}

function getStatusLabel(status: string | undefined, type?: string) {
  if (type === 'virtual_companion_tcp') {
    if (status === 'listening') return 'Listening';
    if (status === 'disabled') return 'Off';
  }
  if (status === 'connected' || status === 'listening')
    return type === 'bot' || type === 'webhook' || type === 'apprise' || type === 'map_upload'
      ? 'Active'
      : 'Connected';
  if (status === 'error') return 'Error';
  if (status === 'disconnected') return 'Disconnected';
  return 'Inactive';
}

function getStatusColor(status: string | undefined, enabled?: boolean) {
  if (enabled === false) return 'bg-muted-foreground';
  if (status === 'connected' || status === 'listening')
    return 'bg-status-connected shadow-[0_0_6px_hsl(var(--status-connected)/0.5)]';
  if (status === 'error' || status === 'disconnected')
    return 'bg-destructive shadow-[0_0_6px_hsl(var(--destructive)/0.5)]';
  return 'bg-muted-foreground';
}

function isVirtualLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function isLiteralIpAddress(host: string) {
  const normalized = host.trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split('.').every((part) => Number(part) <= 255);
  }
  return normalized.includes(':') && /^[0-9a-f:]+$/i.test(normalized);
}

function formatCompanionSessionTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(getLocale());
}

function VirtualCompanionConfigEditor({
  config,
  onChange,
  status,
  radioConnected,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  status?: HealthStatus['fanout_statuses'][string];
  radioConnected: boolean;
}) {
  useLingui();

  const { data: channels = [] } = useQuery({
    queryKey: queryKeys.channels(),
    queryFn: ({ signal }) => api.getChannels(signal),
  });
  const bindHost = String(config.bind_host ?? '0.0.0.0');
  const secureAccess = String(config.secure_access ?? '');
  const remote =
    secureAccess === 'vpn' ||
    secureAccess === 'mtls_proxy' ||
    (!isVirtualLoopbackHost(bindHost) && bindHost !== '0.0.0.0');
  const capacity = Number(config.virtual_channel_capacity ?? 40);
  const slots = Array.isArray(config.channel_slots)
    ? (config.channel_slots as Array<string | null>)
    : [];
  const used = new Set(slots.filter((key): key is string => typeof key === 'string'));
  const availableChannels = channels.filter((channel) => !used.has(channel.key));
  const [channelToAdd, setChannelToAdd] = useState('');
  const sessions = status?.client_sessions ?? [];
  const statusLabel =
    status?.status === 'listening' ? t`Listening` : status?.status === 'error' ? t`Error` : t`Off`;

  const updateAccessMode = (mode: string) => {
    if (mode === 'loopback' || mode === 'lan') {
      onChange({
        ...config,
        bind_host: mode === 'lan' ? '0.0.0.0' : '127.0.0.1',
        secure_access: '',
        unsafe_network_acknowledged: false,
      });
      return;
    }
    onChange({
      ...config,
      bind_host: isVirtualLoopbackHost(bindHost) || bindHost === '0.0.0.0' ? '' : bindHost,
      secure_access: mode,
      unsafe_network_acknowledged: false,
    });
  };

  const addChannel = () => {
    if (!channelToAdd || used.has(channelToAdd)) return;
    const next = [...slots];
    let index = next.findIndex((key) => key === null);
    if (index < 0) index = next.length;
    if (index >= capacity) return;
    next[index] = channelToAdd;
    onChange({ ...config, channel_slots: next });
    setChannelToAdd('');
  };

  const removeChannel = (index: number) => {
    const next = [...slots];
    next[index] = null;
    while (next.length > 0 && next[next.length - 1] === null) next.pop();
    onChange({ ...config, channel_slots: next });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
        <Trans>
          In the official app, enter <strong>MESHRIK&apos;s hostname</strong> and this virtual TCP
          port. Never enter the physical Companion radio&apos;s TCP address or port.
        </Trans>
      </div>

      <section className="space-y-3" aria-labelledby="virtual-companion-status-heading">
        <h3
          id="virtual-companion-status-heading"
          className="text-base font-semibold tracking-tight"
        >
          <Trans>Status</Trans>
        </h3>
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div>
            <span className="text-muted-foreground">
              <Trans>Listener:</Trans>
            </span>{' '}
            {statusLabel}
          </div>
          <div>
            <span className="text-muted-foreground">
              <Trans>Endpoint:</Trans>
            </span>{' '}
            {status?.bind_host ?? bindHost}:{status?.port ?? String(config.port ?? 5000)}
          </div>
          <div>
            <span className="text-muted-foreground">
              <Trans>Clients:</Trans>
            </span>{' '}
            {status?.clients ?? 0}
          </div>
        </div>
        {status?.identity_status === 'verified' && status.identity_public_key ? (
          <div className="space-y-1">
            <div className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
              <Trans>Shared node identity</Trans>
            </div>
            <code className="text-xs" aria-label={t`Verified shared public identity`}>
              {status.identity_public_key.slice(0, 12)}…{status.identity_public_key.slice(-8)}
            </code>
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>
                Read-only public identity shared by all connected apps. Private keys never leave the
                backend.
              </Trans>
            </p>
          </div>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Shared identity unavailable until the physical radio identity has been verified.
            </Trans>
          </p>
        )}
        {!radioConnected && (
          <p className="text-[0.8125rem] text-warning" role="status">
            <Trans>
              Physical radio disconnected. The virtual listener can still serve cached data, but
              radio sends are unavailable until it reconnects.
            </Trans>
          </p>
        )}
        {sessions.length > 0 ? (
          <ul className="space-y-2" aria-label={t`Connected virtual Companion clients`}>
            {sessions.map((session) => (
              <li
                key={session.session_id}
                className="rounded-md border border-input px-3 py-2 text-xs"
              >
                <div className="font-medium">
                  {session.session_id} · {session.status}
                </div>
                <div className="text-muted-foreground">
                  <Trans>
                    Protocol {session.protocol_version ?? 'not negotiated'} · identity{' '}
                    {session.identity_verified ? 'verified' : 'pending'}
                  </Trans>
                </div>
                <div className="text-muted-foreground">
                  <Trans>
                    Connected {formatCompanionSessionTime(session.connected_at)} · last seen{' '}
                    {formatCompanionSessionTime(session.last_seen_at)}
                  </Trans>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No virtual app clients are connected.</Trans>
          </p>
        )}
      </section>

      <Separator />

      <section className="space-y-3" aria-labelledby="virtual-companion-connection-heading">
        <h3
          id="virtual-companion-connection-heading"
          className="text-base font-semibold tracking-tight"
        >
          <Trans>Connection</Trans>
        </h3>
        <div className="space-y-2">
          <Label htmlFor="virtual-companion-access">
            <Trans>Access</Trans>
          </Label>
          <select
            id="virtual-companion-access"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={remote ? secureAccess || `vpn` : bindHost === '0.0.0.0' ? `lan` : `loopback`}
            onChange={(event) => updateAccessMode(event.target.value)}
          >
            <option value="lan">
              <Trans>Local area network (0.0.0.0)</Trans>
            </option>
            <option value="loopback">
              <Trans>This MESHRIK device only (localhost)</Trans>
            </option>
            <option value="vpn">
              <Trans>Remote through a protected VPN</Trans>
            </option>
            <option value="mtls_proxy">
              <Trans>Remote through an mTLS proxy</Trans>
            </option>
          </select>
        </div>
        {remote ? (
          <div className="space-y-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-[0.8125rem] text-destructive">
              <Trans>
                Raw Companion TCP has no HTTP Basic auth or built-in TLS. Bind only an address
                reachable through the selected protected transport; never expose this port publicly.
              </Trans>
            </p>
            <div className="space-y-2">
              <Label htmlFor="virtual-companion-host">
                <Trans>Protected bind address</Trans>
              </Label>
              <Input
                id="virtual-companion-host"
                value={bindHost}
                placeholder={t`VPN or proxy-facing literal IP`}
                onChange={(event) => onChange({ ...config, bind_host: event.target.value })}
                aria-describedby="virtual-companion-host-help"
              />
              <p id="virtual-companion-host-help" className="text-xs text-muted-foreground">
                <Trans>
                  Use a literal IP assigned to this host. Wildcard/public exposure is not
                  recommended.
                </Trans>
              </p>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={config.unsafe_network_acknowledged === true}
                onChange={(event) =>
                  onChange({ ...config, unsafe_network_acknowledged: event.target.checked })
                }
              />
              <span>
                <Trans>
                  I confirm this address is protected by the selected VPN or mTLS proxy and is not
                  publicly exposed.
                </Trans>
              </span>
            </label>
            <a
              className="text-sm text-primary underline underline-offset-4"
              href="https://github.com/Bjorkan/MESHRIK/blob/main/README_ADVANCED.md"
              target="_blank"
              rel="noreferrer"
            >
              <Trans>Open the MESHRIK security guide</Trans>
            </a>
          </div>
        ) : bindHost === '0.0.0.0' ? (
          <p className="text-[0.8125rem] text-warning">
            <Trans>
              Listens on all IPv4 interfaces, not only the LAN. Connect using this MESHRIK
              host&apos;s LAN address, not 0.0.0.0. Raw TCP has no authentication or encryption;
              restrict this port to trusted devices with a firewall and never expose it publicly.
            </Trans>
          </p>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Localhost cannot be reached by a phone or another device. Choose a protected remote
              option only when your network transport is already secured.
            </Trans>
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="virtual-companion-port">
              <Trans>Virtual TCP port</Trans>
            </Label>
            <Input
              id="virtual-companion-port"
              type="number"
              min="1"
              max="65535"
              value={getNumberInputValue(config.port, 5000)}
              onChange={(event) =>
                onChange({ ...config, port: parseIntegerInputValue(event.target.value) })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="virtual-companion-capacity">
              <Trans>Virtual channel slots</Trans>
            </Label>
            <Input
              id="virtual-companion-capacity"
              type="number"
              min="1"
              max="255"
              value={getNumberInputValue(config.virtual_channel_capacity, 40)}
              onChange={(event) =>
                onChange({
                  ...config,
                  virtual_channel_capacity: parseIntegerInputValue(event.target.value),
                })
              }
            />
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3" aria-labelledby="virtual-companion-channels-heading">
        <h3
          id="virtual-companion-channels-heading"
          className="text-base font-semibold tracking-tight"
        >
          <Trans>DB-backed channel selection</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            These stable virtual indexes select MESHRIK DB channels. They never reassign hardware
            channel slots. Removing a channel leaves other virtual indexes unchanged.
          </Trans>
        </p>
        {slots.some((key) => key !== null) ? (
          <ul className="space-y-2" aria-label={t`Configured virtual channel slots`}>
            {slots.map(
              (key, index) =>
                key && (
                  <li
                    key={`${index}-${key}`}
                    className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-xs">
                      <Trans>Slot {index}</Trans>
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {channels.find((channel) => channel.key === key)?.name ??
                        t`Deleted or unavailable channel`}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeChannel(index)}
                      aria-label={t`Remove virtual slot ${index}`}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </li>
                )
            )}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No virtual channels selected.</Trans>
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            aria-label={t`Channel to add to virtual slots`}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={channelToAdd}
            onChange={(event) => setChannelToAdd(event.target.value)}
          >
            <option value="">
              <Trans>Select a DB channel…</Trans>
            </option>
            {availableChannels.map((channel) => (
              <option key={channel.key} value={channel.key}>
                {channel.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            onClick={addChannel}
            disabled={!channelToAdd || slots.filter((key) => key !== null).length >= capacity}
          >
            <Trans>Add stable slot</Trans>
          </Button>
        </div>
      </section>

      <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
        <Trans>
          Saving a changed bind address, port, channel map, or disabling this integration
          disconnects virtual clients. It does not disconnect MESHRIK&apos;s physical radio or
          cancel active scheduled radio jobs. Unsupported firmware administration actions remain
          blocked.
        </Trans>
      </div>
    </div>
  );
}

function MqttPrivateConfigEditor({
  config,
  scope,
  onChange,
  onScopeChange,
}: {
  config: Record<string, unknown>;
  scope: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onScopeChange: (scope: Record<string, unknown>) => void;
}) {
  useLingui();

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Forward mesh data to your own MQTT broker for home automation, logging, or alerting.
        </Trans>
      </p>

      <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
        <Trans>
          Outgoing messages (DMs and group messages) will be reported to private MQTT brokers in
          decrypted/plaintext form.
        </Trans>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-mqtt-host">
            <Trans>Broker Host</Trans>
          </Label>
          <Input
            id="fanout-mqtt-host"
            type="text"
            placeholder={t`e.g. 192.168.1.100`}
            value={(config.broker_host as string) || ''}
            onChange={(e) => onChange({ ...config, broker_host: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-mqtt-port">
            <Trans>Broker Port</Trans>
          </Label>
          <Input
            id="fanout-mqtt-port"
            type="number"
            min="1"
            max="65535"
            value={getNumberInputValue(config.broker_port, 1883)}
            onChange={(e) =>
              onChange({ ...config, broker_port: parseIntegerInputValue(e.target.value) })
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-mqtt-user">
            <Trans>Username</Trans>
          </Label>
          <Input
            id="fanout-mqtt-user"
            type="text"
            placeholder={t`Optional`}
            value={(config.username as string) || ''}
            onChange={(e) => onChange({ ...config, username: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-mqtt-pass">
            <Trans>Password</Trans>
          </Label>
          <Input
            id="fanout-mqtt-pass"
            type="password"
            placeholder={t`Optional`}
            value={(config.password as string) || ''}
            onChange={(e) => onChange({ ...config, password: e.target.value })}
          />
        </div>
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={!!config.use_tls}
          onChange={(e) => onChange({ ...config, use_tls: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm">
          <Trans>Use TLS</Trans>
        </span>
      </label>

      {!!config.use_tls && (
        <label className="flex items-center gap-3 cursor-pointer ml-7">
          <input
            type="checkbox"
            checked={!!config.tls_insecure}
            onChange={(e) => onChange({ ...config, tls_insecure: e.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm">
            <Trans>Skip certificate verification</Trans>
          </span>
        </label>
      )}

      <Separator />

      <div className="space-y-2">
        <Label htmlFor="fanout-mqtt-prefix">
          <Trans>Topic Prefix</Trans>
        </Label>
        <Input
          id="fanout-mqtt-prefix"
          type="text"
          placeholder={t`meshcore`}
          value={(config.topic_prefix as string | undefined) ?? ''}
          onChange={(e) => onChange({ ...config, topic_prefix: e.target.value })}
        />
      </div>

      <Separator />

      <ScopeSelector scope={scope} onChange={onScopeChange} showRawPackets />
    </div>
  );
}

function MqttHaConfigEditor({
  config,
  scope,
  onChange,
  onScopeChange,
}: {
  config: Record<string, unknown>;
  scope: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onScopeChange: (scope: Record<string, unknown>) => void;
}) {
  useLingui();

  const { data: contacts = [] } = useQuery({
    queryKey: queryKeys.contacts(),
    queryFn: ({ signal }) => fetchAllContacts(signal),
  });
  const { data: appSettings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: ({ signal }) => api.getSettings(signal),
  });
  const { data: radioConfig = null } = useQuery({
    queryKey: queryKeys.radioConfig(),
    queryFn: () => api.getRadioConfig(),
  });
  const trackedRepeaters = appSettings?.tracked_telemetry_repeaters ?? EMPTY_TRACKED_KEYS;
  const [contactSearch, setContactSearch] = useState('');

  const selectedContacts = (config.tracked_contacts as string[]) || EMPTY_TRACKED_KEYS;
  const selectedRepeaters = (config.tracked_repeaters as string[]) || EMPTY_TRACKED_KEYS;

  const contactOptions = useMemo(
    () => contacts.filter((c) => c.type === 0 || c.type === 1 || c.type === 3),
    [contacts]
  );

  const repeaterOptions = useMemo(
    () => contacts.filter((c) => c.type === 2 && trackedRepeaters.includes(c.public_key)),
    [contacts, trackedRepeaters]
  );

  const contactSearchLower = contactSearch.toLowerCase().trim();
  const filteredContacts = useMemo(() => {
    const matches = contactOptions.filter((c) => {
      if (!contactSearchLower) return true;
      const name = (c.name || '').toLowerCase();
      const key = c.public_key.toLowerCase();
      return name.includes(contactSearchLower) || key.startsWith(contactSearchLower);
    });
    // Selected contacts sort to top
    return matches.sort((a, b) => {
      const aSelected = selectedContacts.includes(a.public_key) ? 0 : 1;
      const bSelected = selectedContacts.includes(b.public_key) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return (a.name || a.public_key).localeCompare(b.name || b.public_key);
    });
  }, [contactOptions, contactSearchLower, selectedContacts]);

  const selectedContactDetails = useMemo(
    () => contactOptions.filter((c) => selectedContacts.includes(c.public_key)),
    [contactOptions, selectedContacts]
  );
  const selectedRepeaterDetails = useMemo(
    () => repeaterOptions.filter((c) => selectedRepeaters.includes(c.public_key)),
    [repeaterOptions, selectedRepeaters]
  );
  const prefix = ((config.topic_prefix as string) || 'meshcore').trim() || 'meshcore';

  const nodeIdForKey = useCallback((publicKey: string) => publicKey.slice(0, 12).toLowerCase(), []);

  const topicSummary = useMemo(() => {
    const items: Array<{
      kind: 'radio' | 'event' | 'repeater' | 'contact';
      label: string;
      publicKey: string;
      nodeId: string;
      topics: string[];
    }> = [];

    if (radioConfig?.public_key) {
      const nodeId = nodeIdForKey(radioConfig.public_key);
      items.push({
        kind: 'radio',
        label: radioConfig.name || radioConfig.public_key.slice(0, 12),
        publicKey: radioConfig.public_key,
        nodeId,
        topics: [`${prefix}/${nodeId}/health`],
      });
      items.push({
        kind: 'event',
        label: radioConfig.name || radioConfig.public_key.slice(0, 12),
        publicKey: radioConfig.public_key,
        nodeId,
        topics: [`${prefix}/${nodeId}/events/message`],
      });
    }

    for (const repeater of selectedRepeaterDetails) {
      const nodeId = nodeIdForKey(repeater.public_key);
      items.push({
        kind: 'repeater',
        label: repeater.name || repeater.public_key.slice(0, 12),
        publicKey: repeater.public_key,
        nodeId,
        topics: [`${prefix}/${nodeId}/telemetry`],
      });
    }

    for (const contact of selectedContactDetails) {
      const nodeId = nodeIdForKey(contact.public_key);
      items.push({
        kind: 'contact',
        label: contact.name || contact.public_key.slice(0, 12),
        publicKey: contact.public_key,
        nodeId,
        topics: [`${prefix}/${nodeId}/gps`],
      });
    }

    return items;
  }, [nodeIdForKey, prefix, radioConfig, selectedContactDetails, selectedRepeaterDetails]);

  const kindLabel: Record<(typeof topicSummary)[number]['kind'], string> = {
    radio: 'Local radio state',
    event: 'Message events',
    repeater: 'Repeater telemetry',
    contact: 'Contact GPS',
  };
  const localRadioNodeId = radioConfig?.public_key
    ? nodeIdForKey(radioConfig.public_key)
    : '<radio_node_id>';
  const exampleRepeaterNodeId =
    selectedRepeaterDetails.length > 0
      ? nodeIdForKey(selectedRepeaterDetails[0].public_key)
      : '<repeater_node_id>';
  const exampleContactNodeId =
    selectedContactDetails.length > 0
      ? nodeIdForKey(selectedContactDetails[0].public_key)
      : '<contact_node_id>';

  const toggleTrackedContact = (key: string) => {
    const current = [...selectedContacts];
    const idx = current.indexOf(key);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(key);
    onChange({ ...config, tracked_contacts: current });
  };

  const toggleTrackedRepeater = (key: string) => {
    const current = [...selectedRepeaters];
    const idx = current.indexOf(key);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(key);
    onChange({ ...config, tracked_repeaters: current });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight">
            <Trans>Home Assistant MQTT Discovery</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Publish discovery configs and MeshCore state to your MQTT broker so Home Assistant
              creates native devices, sensors, GPS trackers, and message events automatically.
            </Trans>
          </p>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-md border border-border/70 bg-background/80 p-3">
            <div className="text-sm font-medium text-foreground">
              <Trans>1. Same broker</Trans>
            </div>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              <Trans>
                Home Assistant&apos;s built-in MQTT integration must point at the same broker
                configured below.
              </Trans>
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/80 p-3">
            <div className="text-sm font-medium text-foreground">
              <Trans>2. Pick what to expose</Trans>
            </div>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              <Trans>
                Choose repeaters for telemetry sensors and contacts for GPS tracker entities.
              </Trans>
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/80 p-3">
            <div className="text-sm font-medium text-foreground">
              <Trans>3. Automate in HA</Trans>
            </div>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              <Trans>
                Radio health and message events publish continuously; repeater and contact data
                update when new data is heard or collected.
              </Trans>
            </p>
          </div>
        </div>

        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Uses{' '}
            <span
              role="link"
              tabIndex={0}
              className="underline cursor-pointer hover:text-primary transition-colors"
              onClick={() =>
                window.open(
                  'https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery',
                  '_blank'
                )
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  window.open(
                    'https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery',
                    '_blank'
                  );
              }}
            >
              MQTT Discovery
            </span>{' '}
            and the topic conventions documented in{' '}
            <span
              role="link"
              tabIndex={0}
              className="underline cursor-pointer hover:text-primary transition-colors"
              onClick={() =>
                window.open('https://github.com/Bjorkan/MESHRIK/blob/main/README_HA.md', '_blank')
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  window.open(
                    'https://github.com/Bjorkan/MESHRIK/blob/main/README_HA.md',
                    '_blank'
                  );
              }}
            >
              README_HA.md
            </span>
            .
          </Trans>
        </p>
      </div>

      <details className="group">
        <summary className="text-sm font-medium text-foreground cursor-pointer select-none flex items-center gap-1">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
          <Trans>What gets created in Home Assistant</Trans>
        </summary>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground rounded-md border border-border bg-muted/20 p-3">
          <div>
            <span className="font-medium text-foreground">
              <Trans>Local radio device</Trans>
            </span>{' '}
            <Trans>(always)</Trans>
            <span className="ml-1">
              <Trans>&mdash; updates every 60s</Trans>
            </span>
            <ul className="mt-0.5 ml-4 list-disc space-y-0.5">
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`binary_sensor.meshcore_${localRadioNodeId}_connected`}
                  </code>{' '}
                  &mdash; radio online/offline
                </Trans>
              </li>
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${localRadioNodeId}_noise_floor`}
                  </code>{' '}
                  &mdash; radio noise floor (dBm)
                </Trans>
              </li>
            </ul>
          </div>

          <div>
            <span className="font-medium text-foreground">
              <Trans>Per tracked repeater</Trans>
            </span>{' '}
            <Trans>
              &mdash; updates on telemetry collect cycle (~8h) or manual dashboard fetch. Entity IDs
              shown use one repeater for example; these sensors are created for each selected
              repeater.
            </Trans>
            <ul className="mt-0.5 ml-4 list-disc space-y-0.5">
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_battery_voltage`}
                  </code>{' '}
                  (V)
                </Trans>
              </li>
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_noise_floor`}
                  </code>
                  ,{' '}
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_last_rssi`}
                  </code>
                  ,{' '}
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_last_snr`}
                  </code>{' '}
                  (dBm/dB)
                </Trans>
              </li>
              <li>
                <code className="text-[0.6875rem]">
                  {t`sensor.meshcore_${exampleRepeaterNodeId}_packets_received`}
                </code>
                ,{' '}
                <code className="text-[0.6875rem]">
                  {t`sensor.meshcore_${exampleRepeaterNodeId}_packets_sent`}
                </code>
              </li>
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_uptime`}
                  </code>{' '}
                  (seconds)
                </Trans>
              </li>
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_lpp_temperature_ch1`}
                  </code>
                  ,{' '}
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleRepeaterNodeId}_lpp_humidity_ch1`}
                  </code>
                  , etc. &mdash; CayenneLPP sensors (auto-detected from repeater)
                </Trans>
              </li>
            </ul>
          </div>

          <div>
            <span className="font-medium text-foreground">
              <Trans>Per tracked contact</Trans>
            </span>{' '}
            <Trans>
              &mdash; updates passively when advertisements with GPS are heard, and from any GPS
              reading in the contact&apos;s CayenneLPP telemetry. Shown for one contact; a tracker
              is created for each selected contact.
            </Trans>
            <ul className="mt-0.5 ml-4 list-disc space-y-0.5">
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`device_tracker.meshcore_${exampleContactNodeId}`}
                  </code>{' '}
                  &mdash; latitude/longitude (plus altitude when telemetry provides it)
                </Trans>
              </li>
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`sensor.meshcore_${exampleContactNodeId}_lpp_temperature_ch1`}
                  </code>
                  , etc. &mdash; CayenneLPP sensors (when the contact is tracked for telemetry; GPS
                  goes to the tracker above)
                </Trans>
              </li>
            </ul>
          </div>

          <div>
            <span className="font-medium text-foreground">
              <Trans>Message events</Trans>
            </span>{' '}
            <Trans>&mdash; fires for each message matching the scope below</Trans>
            <ul className="mt-0.5 ml-4 list-disc space-y-0.5">
              <li>
                <Trans>
                  <code className="text-[0.6875rem]">
                    {`event.meshcore_${localRadioNodeId}_messages`}
                  </code>{' '}
                  &mdash; trigger automations on sender, channel, or message content
                </Trans>
              </li>
            </ul>
          </div>

          <p className="text-[0.6875rem] mt-1.5">
            <Trans>
              Entity IDs use the first 12 characters of the node&apos;s public key. Entities are
              removed from HA when this integration is disabled or deleted. State topics are
              published under{' '}
              <code className="text-[0.6875rem]">
                {prefix}/&lt;node_id&gt;/health|telemetry|gps
              </code>
              .
            </Trans>
          </p>
        </div>
      </details>

      <details className="group">
        <summary className="text-sm font-medium text-foreground cursor-pointer select-none flex items-center gap-1">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
          <Trans>Published topic summary</Trans>
        </summary>
        <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            <Trans>
              Home Assistant device and entity IDs are keyed off the first 12 characters of each
              node&apos;s public key, not the display name. Those same 12 characters are used in the
              MQTT state topics below.
            </Trans>
          </p>
          {topicSummary.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              <Trans>
                No topic previews available yet. Connect to a radio to resolve the local radio key,
                and select contacts or repeaters above to preview their published topics.
              </Trans>
            </p>
          ) : (
            <div className="space-y-2">
              {topicSummary.map((item) => (
                <div
                  key={`${item.kind}-${item.publicKey}`}
                  className="rounded border border-border/70 bg-background/70 p-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-medium text-foreground">{kindLabel[item.kind]}</span>
                    <span className="text-foreground">{item.label}</span>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      <Trans>node id {item.nodeId}</Trans>
                    </span>
                  </div>
                  <div className="mt-1 text-[0.6875rem] text-muted-foreground font-mono break-all">
                    <Trans>key {item.publicKey}</Trans>
                  </div>
                  {item.topics.map((topic) => (
                    <div
                      key={topic}
                      className="mt-1 rounded bg-muted px-2 py-1 text-[0.6875rem] font-mono text-foreground break-all"
                    >
                      {topic}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <p className="text-[0.6875rem] text-muted-foreground">
            <Trans>
              Discovery config topics are also published under{' '}
              <code className="text-[0.6875rem]">homeassistant/.../config</code>, but the topics
              above are the primary runtime state and event topics.
            </Trans>
          </p>
        </div>
      </details>

      <Separator />

      <h3 className="text-base font-semibold tracking-tight">
        <Trans>MQTT Broker</Trans>
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-ha-host">
            <Trans>Broker Host</Trans>
          </Label>
          <Input
            id="fanout-ha-host"
            type="text"
            placeholder={t`e.g. 192.168.1.100`}
            value={(config.broker_host as string) || ''}
            onChange={(e) => onChange({ ...config, broker_host: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-ha-port">
            <Trans>Broker Port</Trans>
          </Label>
          <Input
            id="fanout-ha-port"
            type="number"
            min="1"
            max="65535"
            value={getNumberInputValue(config.broker_port, 1883)}
            onChange={(e) =>
              onChange({ ...config, broker_port: parseIntegerInputValue(e.target.value) })
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-ha-user">
            <Trans>Username</Trans>
          </Label>
          <Input
            id="fanout-ha-user"
            type="text"
            placeholder={t`Optional`}
            value={(config.username as string) || ''}
            onChange={(e) => onChange({ ...config, username: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-ha-pass">
            <Trans>Password</Trans>
          </Label>
          <Input
            id="fanout-ha-pass"
            type="password"
            placeholder={t`Optional`}
            value={(config.password as string) || ''}
            onChange={(e) => onChange({ ...config, password: e.target.value })}
          />
        </div>
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={!!config.use_tls}
          onChange={(e) => onChange({ ...config, use_tls: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm">
          <Trans>Use TLS</Trans>
        </span>
      </label>

      {!!config.use_tls && (
        <label className="flex items-center gap-3 cursor-pointer ml-7">
          <input
            type="checkbox"
            checked={!!config.tls_insecure}
            onChange={(e) => onChange({ ...config, tls_insecure: e.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm">
            <Trans>Skip certificate verification</Trans>
          </span>
        </label>
      )}

      <div className="space-y-2">
        <Label htmlFor="fanout-ha-prefix">
          <Trans>Topic Prefix</Trans>
        </Label>
        <Input
          id="fanout-ha-prefix"
          type="text"
          placeholder={t`meshcore`}
          value={(config.topic_prefix as string | undefined) ?? ''}
          onChange={(e) => onChange({ ...config, topic_prefix: e.target.value })}
        />
        <p className="text-[0.6875rem] text-muted-foreground">
          <Trans>
            State updates publish under <code className="text-[0.6875rem]">{prefix}/</code>.
            Discovery configs always use the{' '}
            <code className="text-[0.6875rem]">homeassistant/</code> prefix.
          </Trans>
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>GPS Tracked Contacts</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Each selected contact becomes a <code className="text-[0.6875rem]">device_tracker</code>{' '}
            in HA, updated whenever an advertisement with GPS coordinates is heard. Useful for
            tracking mobile nodes on an HA map dashboard.
          </Trans>
        </p>

        {selectedContactDetails.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedContactDetails.map((c) => (
              <span
                key={c.public_key}
                className="inline-flex items-center gap-1 text-[0.6875rem] px-2 py-0.5 rounded-full bg-primary/10 text-primary"
              >
                {c.name || c.public_key.slice(0, 12)}
                <button
                  type="button"
                  className="ml-0.5 hover:text-destructive transition-colors"
                  onClick={() => toggleTrackedContact(c.public_key)}
                  aria-label={t`Remove ${c.name || c.public_key.slice(0, 12)}`}
                >
                  <Trans>&times;</Trans>
                </button>
              </span>
            ))}
          </div>
        )}

        {contactOptions.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground italic">
            <Trans>No contacts available.</Trans>
          </p>
        ) : (
          <>
            <Input
              type="text"
              placeholder={t`Search ${contactOptions.length} contacts...`}
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2">
              {filteredContacts.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground italic py-1">
                  <Trans>No contacts match &ldquo;{contactSearch}&rdquo;</Trans>
                </p>
              ) : (
                filteredContacts.map((c) => (
                  <label
                    key={c.public_key}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedContacts.includes(c.public_key)}
                      onChange={() => toggleTrackedContact(c.public_key)}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                    <span className="truncate">{c.name || c.public_key.slice(0, 12)}</span>
                    <span className="text-[0.625rem] text-muted-foreground ml-auto font-mono shrink-0">
                      {c.public_key.slice(0, 12)}
                    </span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Telemetry Tracked Repeaters</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Each selected repeater becomes an HA device with sensors for battery voltage, RSSI, SNR,
            noise floor, packet counts, and uptime. Data updates whenever telemetry is collected
            (auto-collect runs every ~8 hours, or on manual dashboard fetch). Only repeaters already
            in the auto-telemetry tracking list appear here (add new repeaters by logging into the
            repeater and opting in at the bottom of the page).
          </Trans>
        </p>
        {trackedRepeaters.length === 0 ? (
          <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-[0.8125rem] text-muted-foreground">
            <Trans>
              No repeaters are being auto-tracked for telemetry. Add repeaters to the auto-telemetry
              tracking list in the Radio section first, then return here to select which ones to
              expose to HA.
            </Trans>
          </div>
        ) : repeaterOptions.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground italic">
            <Trans>Auto-tracked repeaters not found in contact list.</Trans>
          </p>
        ) : (
          <div className="max-h-40 overflow-y-auto space-y-1 rounded border border-border p-2">
            {repeaterOptions.map((c) => (
              <label key={c.public_key} className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={selectedRepeaters.includes(c.public_key)}
                  onChange={() => toggleTrackedRepeater(c.public_key)}
                  className="h-3.5 w-3.5 rounded border-border"
                />
                <span className="truncate">{c.name || c.public_key.slice(0, 12)}</span>
                <span className="text-[0.625rem] text-muted-foreground ml-auto font-mono">
                  {c.public_key.slice(0, 12)}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Message Events</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Matching messages fire an{' '}
            <code className="text-[0.6875rem]">{`event.meshcore_${localRadioNodeId}_messages`}</code>{' '}
            entity in HA with sender, text, channel, and direction attributes. Use HA automations to
            trigger actions on specific messages, channels, or contacts.
          </Trans>
        </p>
      </div>
      <ScopeSelector scope={scope} onChange={onScopeChange} />
    </div>
  );
}

function MqttCommunityConfigEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  useLingui();

  const authMode = (config.auth_mode as string) || DEFAULT_COMMUNITY_AUTH_MODE;
  const isMeshRank = config.profile === 'meshrank';
  const websocketPathError = getCommunityWebsocketPathError(config.websocket_path);
  const configuredPreset = config.preset
    ? communityPresets[config.preset as keyof typeof communityPresets]
    : undefined;
  const websocketPathIsPresetGenerated =
    config._websocket_path_source === 'preset' ||
    Boolean(
      configuredPreset &&
      String(config.websocket_path ?? '').trim() === configuredPreset.websocket_path
    );
  const legacyRootPathPreset = Object.values(communityPresets).find(
    (preset) =>
      preset.transport === 'websockets' &&
      preset.websocket_path === DEFAULT_COMMUNITY_WEBSOCKET_PATH &&
      preset.host === String(config.broker_host ?? '').trim() &&
      String(config.websocket_path ?? '').trim() === '/mqtt'
  );

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Advanced community MQTT editor. Use this for manual meshcoretomqtt-compatible setups or
          for modifying a saved preset after creation. Only raw RF packets are shared &mdash; never
          decrypted messages.
        </Trans>
      </p>

      <div className="space-y-2">
        <Label htmlFor="fanout-comm-preset">
          <Trans>Verified broker profile</Trans>
        </Label>
        <select
          id="fanout-comm-preset"
          value={(config.preset as string) || ''}
          onChange={(e) => {
            const key = e.target.value as keyof typeof communityPresets;
            const preset = communityPresets[key];
            if (!preset) return;
            const currentPath = String(config.websocket_path ?? '').trim();
            const pathSource = config._websocket_path_source;
            const canReplacePath =
              !currentPath ||
              currentPath === preset.websocket_path ||
              pathSource === 'default' ||
              websocketPathIsPresetGenerated;
            if (
              !canReplacePath &&
              !window.confirm(
                `Replace your custom WebSocket path (${currentPath}) with ${preset.websocket_path}?`
              )
            ) {
              return;
            }
            onChange({
              ...config,
              preset: key,
              profile: preset.profile,
              broker_host: preset.host || config.broker_host,
              broker_port: preset.port,
              transport: preset.transport,
              websocket_path: preset.websocket_path,
              _websocket_path_source: 'preset',
              auth_mode: preset.auth_mode,
              use_tls: true,
              tls_verify: true,
              token_audience: preset.auth_mode === 'token' ? preset.host : '',
              publish_neighbors: preset.supports_neighbors
                ? config.publish_neighbors === true
                : false,
            });
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">
            <Trans>Existing custom/legacy settings</Trans>
          </option>
          {Object.entries(communityPresets).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          <Trans>
            Selecting a preset changes connection defaults; existing saved broker overrides remain
            unchanged until you select one.
          </Trans>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-host">
            <Trans>Broker Host</Trans>
          </Label>
          <Input
            id="fanout-comm-host"
            type="text"
            placeholder={DEFAULT_COMMUNITY_BROKER_HOST}
            value={(config.broker_host as string | undefined) ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                broker_host: e.target.value,
                preset: '',
                ...(websocketPathIsPresetGenerated
                  ? {
                      websocket_path: DEFAULT_COMMUNITY_WEBSOCKET_PATH,
                      _websocket_path_source: 'default',
                    }
                  : {}),
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-port">
            <Trans>Broker Port</Trans>
          </Label>
          <Input
            id="fanout-comm-port"
            type="number"
            min="1"
            max="65535"
            value={getNumberInputValue(config.broker_port, DEFAULT_COMMUNITY_BROKER_PORT)}
            onChange={(e) =>
              onChange({
                ...config,
                broker_port: parseIntegerInputValue(e.target.value),
              })
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-transport">
            <Trans>Transport</Trans>
          </Label>
          <select
            id="fanout-comm-transport"
            value={(config.transport as string) || DEFAULT_COMMUNITY_TRANSPORT}
            onChange={(e) =>
              onChange({
                ...config,
                transport: e.target.value,
                ...(!config.websocket_path && e.target.value === 'websockets'
                  ? {
                      websocket_path: DEFAULT_COMMUNITY_WEBSOCKET_PATH,
                      _websocket_path_source: 'default',
                    }
                  : {}),
              })
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="websockets">
              <Trans>WebSockets</Trans>
            </option>
            <option value="tcp">
              <Trans>TCP</Trans>
            </option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-auth-mode">
            <Trans>Authentication</Trans>
          </Label>
          <select
            id="fanout-comm-auth-mode"
            value={authMode}
            onChange={(e) => onChange({ ...config, auth_mode: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="token">
              <Trans>Token</Trans>
            </option>
            <option value="none">
              <Trans>None</Trans>
            </option>
            <option value="password">
              <Trans>Username / Password</Trans>
            </option>
          </select>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              LetsMesh uses <code>token</code> auth. MeshRank uses <code>none</code>.
            </Trans>
          </p>
        </div>
      </div>

      {((config.transport as string) || DEFAULT_COMMUNITY_TRANSPORT) === 'websockets' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="fanout-comm-ws-path">
              <Trans>WebSocket Path</Trans>
            </Label>
            <Input
              id="fanout-comm-ws-path"
              type="text"
              placeholder="/"
              value={(config.websocket_path as string | undefined) ?? ''}
              aria-invalid={websocketPathError ? true : undefined}
              aria-describedby={websocketPathError ? `fanout-comm-ws-path-error` : undefined}
              onChange={(e) =>
                onChange({
                  ...config,
                  websocket_path: e.target.value,
                  _websocket_path_source: 'custom',
                })
              }
            />
            {websocketPathError && (
              <p id="fanout-comm-ws-path-error" role="alert" className="text-xs text-destructive">
                {websocketPathError}
              </p>
            )}
            {legacyRootPathPreset && (
              <div
                role="status"
                className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
              >
                <p>
                  <Trans>
                    {legacyRootPathPreset.label} uses <code>/</code>. This saved <code>/mqtt</code>{' '}
                    value is preserved in case it was intentional.
                  </Trans>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    onChange({
                      ...config,
                      websocket_path: DEFAULT_COMMUNITY_WEBSOCKET_PATH,
                      _websocket_path_source: 'default',
                    })
                  }
                >
                  <Trans>Use recommended /</Trans>
                </Button>
              </div>
            )}
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>
                Blank values normalize to <code>/</code>. Use <code>/mqtt</code> only for brokers
                that require it; paths cannot contain spaces, <code>?</code> or <code>#</code>.
              </Trans>
            </p>
          </div>
        </div>
      )}

      {authMode === 'token' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="fanout-comm-token-audience">
              <Trans>Token Audience</Trans>
            </Label>
            <Input
              id="fanout-comm-token-audience"
              type="text"
              placeholder={(config.broker_host as string) || DEFAULT_COMMUNITY_BROKER_HOST}
              value={(config.token_audience as string | undefined) ?? ''}
              onChange={(e) => onChange({ ...config, token_audience: e.target.value })}
            />
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>Defaults to the broker host when blank</Trans>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fanout-comm-email">
              <Trans>Owner Email (optional)</Trans>
            </Label>
            <Input
              id="fanout-comm-email"
              type="email"
              placeholder={t`you@example.com`}
              value={(config.email as string) || ''}
              onChange={(e) => onChange({ ...config, email: e.target.value })}
            />
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>Used to claim your node on the community aggregator</Trans>
            </p>
          </div>
        </div>
      )}

      {authMode === 'password' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="fanout-comm-username">
              <Trans>Username</Trans>
            </Label>
            <Input
              id="fanout-comm-username"
              type="text"
              value={(config.username as string) || ''}
              onChange={(e) => onChange({ ...config, username: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fanout-comm-password">
              <Trans>Password</Trans>
            </Label>
            <Input
              id="fanout-comm-password"
              type="password"
              value={(config.password as string) || ''}
              onChange={(e) => onChange({ ...config, password: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.use_tls === undefined ? true : !!config.use_tls}
            onChange={(e) => onChange({ ...config, use_tls: e.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm">
            <Trans>Use TLS</Trans>
          </span>
        </label>

        <label className="flex items-center gap-3 cursor-pointer ml-7">
          <input
            type="checkbox"
            checked={config.tls_verify === undefined ? true : !!config.tls_verify}
            onChange={(e) => onChange({ ...config, tls_verify: e.target.checked })}
            className="h-4 w-4 rounded border-border"
            disabled={config.use_tls === undefined ? false : !config.use_tls}
          />
          <span className="text-sm">
            <Trans>Verify TLS certificates</Trans>
          </span>
        </label>
      </div>

      {isMeshRank && (
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-meshrank-token">
            <Trans>MeshRank uplink token (leave blank to keep existing)</Trans>
          </Label>
          <Input
            id="fanout-comm-meshrank-token"
            type="password"
            autoComplete="new-password"
            value={(config.token as string) || ''}
            onChange={(e) => onChange({ ...config, token: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>
              Generated topics and broker identity are private. The saved token is never returned by
              the API.
            </Trans>
          </p>
        </div>
      )}
      {!isMeshRank && (
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-iata">
            <Trans>Region Code (IATA)</Trans>
          </Label>
          <Input
            id="fanout-comm-iata"
            type="text"
            maxLength={3}
            placeholder={t`e.g. DEN, LAX, NYC`}
            value={(config.iata as string) || ''}
            onChange={(e) => onChange({ ...config, iata: e.target.value.toUpperCase() })}
            className="w-32"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>Your nearest airport&apos;s IATA code (required)</Trans>
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(
          [
            ['publish_status', 'Publish status'],
            ['publish_packets', 'Publish received raw packets'],
            ['publish_neighbors', 'Publish sampled neighbor snapshots'],
          ] as const
        ).map(([field, label]) => (
          <label key={field} className="text-sm flex gap-2 items-center">
            <input
              type="checkbox"
              checked={
                config[field] === undefined ? field !== 'publish_neighbors' : !!config[field]
              }
              onChange={(e) => onChange({ ...config, [field]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <div>
          <Label htmlFor="fanout-comm-status-interval">
            <Trans>Status interval (1–60 min)</Trans>
          </Label>
          <Input
            id="fanout-comm-status-interval"
            type="number"
            min="1"
            max="60"
            value={getNumberInputValue(config.status_interval_minutes, 5)}
            onChange={(e) =>
              onChange({
                ...config,
                status_interval_minutes: parseIntegerInputValue(e.target.value),
              })
            }
          />
        </div>
        <div>
          <Label htmlFor="fanout-comm-neighbor-interval">
            <Trans>Neighbor interval (12–336 h)</Trans>
          </Label>
          <Input
            id="fanout-comm-neighbor-interval"
            type="number"
            min="12"
            max="336"
            value={getNumberInputValue(config.neighbors_interval_hours, 24)}
            onChange={(e) =>
              onChange({
                ...config,
                neighbors_interval_hours: parseIntegerInputValue(e.target.value),
              })
            }
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Neighbor snapshots use only previous host-observed discovery results; scheduling does not
          send automatic radio discovery or mutate radio contacts.
        </Trans>
      </p>

      <div className="space-y-2">
        <Label htmlFor="fanout-comm-tx">
          <Trans>Outbound raw frame upload</Trans>
        </Label>
        <select
          id="fanout-comm-tx"
          value={(config.tx_mode as string) || `off`}
          onChange={(e) => onChange({ ...config, tx_mode: e.target.value })}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="off">
            <Trans>Off (default)</Trans>
          </option>
          <option value="advert">
            <Trans>Advertisements only (future firmware)</Trans>
          </option>
          <option value="on">
            <Trans>All eligible raw TX (future firmware)</Trans>
          </option>
        </select>
        <p className="text-xs text-muted-foreground">
          <Trans>
            Companion protocol 13 does not expose verified raw TX frames. This setting is stored for
            forward compatibility, but no outgoing packet upload is performed. Command send
            acknowledgements are not proof of RF transmission.
          </Trans>
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="fanout-comm-filter">
          <Trans>MeshCore payload type filter</Trans>
        </Label>
        <select
          id="fanout-comm-filter"
          value={
            Array.isArray(config.packet_filter)
              ? `selected`
              : (config.packet_filter as string) || `all`
          }
          onChange={(e) =>
            onChange({
              ...config,
              packet_filter: e.target.value === 'selected' ? [] : e.target.value,
            })
          }
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">
            <Trans>All packet types</Trans>
          </option>
          <option value="none">
            <Trans>None (status only)</Trans>
          </option>
          <option value="selected">
            <Trans>Selected types</Trans>
          </option>
        </select>
        {Array.isArray(config.packet_filter) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Array.from({ length: 16 }, (_, id) => {
              const names: Record<number, string> = {
                0: 'req',
                1: 'response',
                2: 'txt_msg',
                3: 'ack',
                4: 'advert',
                5: 'grp_txt',
                6: 'grp_data',
                7: 'anon_req',
                8: 'path',
                9: 'trace',
                10: 'multipart',
                11: 'control',
                15: 'raw_custom',
              };
              return (
                <label key={id} className="text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={(config.packet_filter as number[]).includes(id)}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        packet_filter: e.target.checked
                          ? [...(config.packet_filter as number[]), id].sort((a, b) => a - b)
                          : (config.packet_filter as number[]).filter((type) => type !== id),
                      })
                    }
                  />
                  {id}: {names[id] || t`reserved`}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {!isMeshRank && (
        <div className="space-y-2">
          <Label htmlFor="fanout-comm-topic-template">
            <Trans>Packet Topic Template</Trans>
          </Label>
          <Input
            id="fanout-comm-topic-template"
            type="text"
            placeholder={DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE}
            value={(config.topic_template as string | undefined) ?? ''}
            onChange={(e) => onChange({ ...config, topic_template: e.target.value })}
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Use <code>{'{IATA}'}</code> and <code>{'{PUBLIC_KEY}'}</code>. Default:{' '}
              <code>{DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE}</code>
            </Trans>
          </p>
        </div>
      )}
    </div>
  );
}

function MeshRankConfigEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  useLingui();

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          MeshRank publishes under a broker-issued token, not an IATA region or a manually
          constructed MQTT topic. Provide only your personal uplink token.
        </Trans>
      </p>
      <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Trans>
          Broker{' '}
          <code>
            {DEFAULT_MESHRANK_BROKER_HOST}:{DEFAULT_MESHRANK_BROKER_PORT}
          </code>
          , TLS with certificate verification. No MQTT username or password.
        </Trans>
      </div>
      <div className="space-y-2">
        <Label htmlFor="fanout-meshrank-token">
          <Trans>MeshRank uplink token</Trans>
        </Label>
        <Input
          id="fanout-meshrank-token"
          type="password"
          autoComplete="new-password"
          placeholder={t`Enter your broker-issued token`}
          value={(config.token as string) || ''}
          onChange={(e) =>
            onChange({ ...config, profile: 'meshrank', token: e.target.value, iata: '' })
          }
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            The token is encrypted at rest and omitted from returned integration details. To rotate
            a saved token, enter the replacement token here.
          </Trans>
        </p>
      </div>
    </div>
  );
}

function LetsMeshConfigEditor({
  config,
  onChange,
  brokerHost,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  brokerHost: string;
}) {
  useLingui();

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Pre-filled LetsMesh setup. This saves as a regular Community MQTT integration once
          created, but only asks for the values LetsMesh expects from you.
        </Trans>
      </p>

      <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Trans>
          Broker <code>{brokerHost}</code> on port <code>{DEFAULT_COMMUNITY_BROKER_PORT}</code> via{' '}
          <code>{DEFAULT_COMMUNITY_TRANSPORT}</code>, auth{' '}
          <code>{DEFAULT_COMMUNITY_AUTH_MODE}</code>, TLS on, certificate verification on, token
          audience fixed to <code>{brokerHost}</code>.
        </Trans>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-letsmesh-email">
            <Trans>Email</Trans>
          </Label>
          <Input
            id="fanout-letsmesh-email"
            type="email"
            placeholder={t`you@example.com`}
            value={(config.email as string) || ''}
            onChange={(e) =>
              onChange({ ...config, email: e.target.value, broker_host: brokerHost })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-letsmesh-iata">
            <Trans>Region Code (IATA)</Trans>
          </Label>
          <Input
            id="fanout-letsmesh-iata"
            type="text"
            maxLength={3}
            placeholder={t`e.g. DEN, LAX, NYC`}
            value={(config.iata as string) || ''}
            onChange={(e) =>
              onChange({
                ...config,
                broker_host: brokerHost,
                token_audience: brokerHost,
                iata: e.target.value.toUpperCase(),
              })
            }
            className="w-32"
          />
        </div>
      </div>
    </div>
  );
}

function BotConfigEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  useLingui();

  const code = (config.code as string) || '';
  return (
    <div className="space-y-3">
      <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md">
        <p className="text-sm text-destructive">
          <Trans>
            <strong>Experimental:</strong> This is an alpha feature and introduces automated message
            sending to your radio; unexpected behavior may occur. Use with caution, and please
            report any bugs!
          </Trans>
        </p>
      </div>

      <div className="p-3 bg-warning/10 border border-warning/30 rounded-md">
        <p className="text-sm text-warning">
          <Trans>
            <strong>Security Warning:</strong> This feature executes arbitrary Python code on the
            server. Only run trusted code, and be cautious of arbitrary usage of message parameters.
          </Trans>
        </p>
      </div>

      <div className="p-3 bg-warning/10 border border-warning/30 rounded-md">
        <p className="text-sm text-warning">
          <Trans>
            <strong>Don&apos;t wreck the mesh!</strong> Bots process ALL messages, including their
            own. Be careful of creating infinite loops!
          </Trans>
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Define a <code className="bg-muted px-1 rounded">bot()</code> function that receives
            message data and optionally returns a reply.
          </Trans>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...config, code: DEFAULT_BOT_CODE })}
        >
          <Trans>Reset to Example</Trans>
        </Button>
      </div>

      <Suspense
        fallback={
          <div className="h-64 md:h-96 rounded-md border border-input bg-code-editor-bg flex items-center justify-center text-muted-foreground">
            <Trans>Loading editor...</Trans>
          </div>
        }
      >
        <BotCodeEditor value={code} onChange={(c) => onChange({ ...config, code: c })} />
      </Suspense>

      <div className="text-[0.8125rem] text-muted-foreground space-y-1">
        <p>
          <Trans>
            <strong>Available:</strong> Standard Python libraries and any modules installed in the
            server environment.
          </Trans>
        </p>
        <p>
          <Trans>
            <strong>Limits:</strong> 10 second timeout per bot.
          </Trans>
        </p>
        <p>
          <Trans>
            <strong>Note:</strong> Bots respond to all messages, including your own. For channel
            messages, <code>sender_key</code> is <code>None</code>. Multiple enabled bots run
            concurrently. Outgoing messages are serialized with a two-second delay between sends to
            prevent repeater collision.
          </Trans>
        </p>
      </div>
    </div>
  );
}

function MapUploadConfigEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  useLingui();

  const isDryRun = config.dry_run !== false;
  const [radioLat, setRadioLat] = useState<number | null>(null);
  const [radioLon, setRadioLon] = useState<number | null>(null);

  useEffect(() => {
    api
      .getRadioConfig()
      .then((rc) => {
        setRadioLat(rc.lat ?? 0);
        setRadioLon(rc.lon ?? 0);
      })
      .catch(() => {
        setRadioLat(0);
        setRadioLon(0);
      });
  }, []);

  const radioLatLonConfigured =
    radioLat !== null && radioLon !== null && !(radioLat === 0 && radioLon === 0);

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Automatically upload heard repeater and room server advertisements to{' '}
          <a
            href="https://map.meshcore.io"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            map.meshcore.io
          </a>
          . Requires the radio&apos;s private key to be available (firmware must have{' '}
          <code>ENABLE_PRIVATE_KEY_EXPORT=1</code>). Only raw RF packets are shared &mdash; never
          decrypted messages.
        </Trans>
      </p>

      <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
        <strong>
          <Trans>Dry Run is {isDryRun ? 'ON' : 'OFF'}.</Trans>
        </strong>{' '}
        {isDryRun
          ? t`No uploads will be sent. Check the backend logs to verify the payload looks correct before enabling live sends.`
          : t`Live uploads are enabled. Each advert is rate-limited to once per hour per node.`}
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={isDryRun}
          onChange={(e) => onChange({ ...config, dry_run: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <div>
          <span className="text-sm font-medium">
            <Trans>Dry Run (log only, no uploads)</Trans>
          </span>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              When enabled, upload payloads are logged at INFO level but not sent. Disable once you
              have confirmed the logged output looks correct.
            </Trans>
          </p>
        </div>
      </label>

      <Separator />

      <div className="space-y-2">
        <Label htmlFor="fanout-map-api-url">
          <Trans>API URL (optional)</Trans>
        </Label>
        <Input
          id="fanout-map-api-url"
          type="url"
          placeholder="https://map.meshcore.io/api/v1/uploader/node"
          value={(config.api_url as string) || ''}
          onChange={(e) => onChange({ ...config, api_url: e.target.value })}
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            Leave blank to use the default <code>map.meshcore.io</code> endpoint.
          </Trans>
        </p>
      </div>

      <Separator />

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={!!config.geofence_enabled}
          onChange={(e) => onChange({ ...config, geofence_enabled: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <div>
          <span className="text-sm font-medium">
            <Trans>Enable Geofence</Trans>
          </span>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Only upload nodes whose location falls within the configured radius of your
              radio&apos;s own position. Helps exclude nodes with false or spoofed coordinates. Uses
              the latitude/longitude set in Radio Settings.
            </Trans>
          </p>
        </div>
      </label>

      {!!config.geofence_enabled && (
        <div className="space-y-3 pl-7">
          {!radioLatLonConfigured && (
            <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
              <Trans>
                Your radio does not currently have a latitude/longitude configured. Geofencing will
                be silently skipped until coordinates are set in{' '}
                <strong>Settings &rarr; Radio &rarr; Location</strong>.
              </Trans>
            </div>
          )}
          {radioLatLonConfigured && (
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>
                Using radio position{' '}
                <code>
                  {radioLat?.toFixed(5)}, {radioLon?.toFixed(5)}
                </code>{' '}
                as the geofence center. Update coordinates in Radio Settings to move the center.
              </Trans>
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="fanout-map-geofence-radius">
              <Trans>Radius (km)</Trans>
            </Label>
            <Input
              id="fanout-map-geofence-radius"
              type="number"
              min="0"
              step="any"
              placeholder={t`e.g. 100`}
              value={getOptionalNumberInputValue(config.geofence_radius_km)}
              onChange={(e) =>
                onChange({
                  ...config,
                  geofence_radius_km: parseFloatInputValue(e.target.value),
                })
              }
            />
            <p className="text-[0.8125rem] text-muted-foreground">
              <Trans>
                Nodes further than this distance from your radio&apos;s position will not be
                uploaded.
              </Trans>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

type ScopeMode = 'all' | 'none' | 'only' | 'except';

function getScopeMode(value: unknown): ScopeMode {
  if (value === 'all') return 'all';
  if (value === 'none') return 'none';
  if (typeof value === 'object' && value !== null) {
    // Check if either channels or contacts uses the {except: [...]} shape
    const obj = value as Record<string, unknown>;
    const ch = obj.channels;
    const co = obj.contacts;
    if (
      (typeof ch === 'object' && ch !== null && !Array.isArray(ch)) ||
      (typeof co === 'object' && co !== null && !Array.isArray(co))
    ) {
      return 'except';
    }
    return 'only';
  }
  return 'all';
}

/** Extract the key list from a filter value, whether it's a plain list or {except: [...]} */
function getFilterKeys(filter: unknown): string[] {
  if (Array.isArray(filter)) return filter as string[];
  if (typeof filter === 'object' && filter !== null && 'except' in filter)
    return ((filter as Record<string, unknown>).except as string[]) ?? [];
  return [];
}

const MAX_SCOPE_PILL_DISPLAY = 32;

interface PillsSearchListItem {
  key: string;
  label: string;
  /** Optional trailing monospace hint (e.g. pubkey prefix) */
  trailing?: string;
}

/**
 * Search-and-pills picker for the generic fanout scope selector.
 * Shows selected items as removable pills (up to MAX_SCOPE_PILL_DISPLAY),
 * a search input, and a scrollable list of filtered items with checkboxes.
 * When more than MAX_SCOPE_PILL_DISPLAY items are selected, the pill row
 * collapses to a single informational badge to keep the interface clean.
 */
function PillsSearchList({
  label,
  labelSuffix,
  items,
  selectedKeys,
  onToggle,
  onAll,
  onNone,
  searchPlaceholder,
  emptyItemsMessage,
}: {
  label: string;
  labelSuffix: string;
  items: PillsSearchListItem[];
  selectedKeys: string[];
  onToggle: (key: string) => void;
  onAll: () => void;
  onNone: () => void;
  searchPlaceholder: string;
  emptyItemsMessage: string;
}) {
  useLingui();

  const [search, setSearch] = useState('');
  const searchLower = search.toLowerCase().trim();

  const filtered = useMemo(() => {
    const matches = items.filter((it) => {
      if (!searchLower) return true;
      return (
        it.label.toLowerCase().includes(searchLower) || it.key.toLowerCase().startsWith(searchLower)
      );
    });
    // Selected items sort to top (mirrors the Home Assistant tracked-contacts picker)
    return matches.sort((a, b) => {
      const aSel = selectedKeys.includes(a.key) ? 0 : 1;
      const bSel = selectedKeys.includes(b.key) ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      return a.label.localeCompare(b.label);
    });
  }, [items, searchLower, selectedKeys]);

  const selectedDetails = useMemo(
    () => items.filter((it) => selectedKeys.includes(it.key)),
    [items, selectedKeys]
  );
  const overPillLimit = selectedDetails.length > MAX_SCOPE_PILL_DISPLAY;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          {label} <span className="text-muted-foreground font-normal">({labelSuffix})</span>
        </Label>
        <span className="flex gap-1">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onAll}
          >
            <Trans>All</Trans>
          </button>
          <span className="text-xs text-muted-foreground">/</span>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onNone}
          >
            <Trans>None</Trans>
          </button>
        </span>
      </div>

      {selectedDetails.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {overPillLimit ? (
            <span className="inline-flex items-center text-[0.6875rem] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              <Trans>
                &gt;{MAX_SCOPE_PILL_DISPLAY} selections made; hiding selection preview to keep the
                interface clean
              </Trans>
            </span>
          ) : (
            selectedDetails.map((it) => (
              <span
                key={it.key}
                className="inline-flex items-center gap-1 text-[0.6875rem] px-2 py-0.5 rounded-full bg-primary/10 text-primary"
              >
                {it.label}
                <button
                  type="button"
                  className="ml-0.5 hover:text-destructive transition-colors"
                  onClick={() => onToggle(it.key)}
                  aria-label={t`Remove ${it.label}`}
                >
                  <Trans>&times;</Trans>
                </button>
              </span>
            ))
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground italic">{emptyItemsMessage}</p>
      ) : (
        <>
          <Input
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
          <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2">
            {filtered.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground italic py-1">
                <Trans>
                  No {label.toLowerCase()} match &ldquo;{search}&rdquo;
                </Trans>
              </p>
            ) : (
              filtered.map((it) => (
                <label key={it.key} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={selectedKeys.includes(it.key)}
                    onChange={() => onToggle(it.key)}
                    className="h-3.5 w-3.5 rounded border-input accent-primary"
                  />
                  <span className="truncate">{it.label}</span>
                  {it.trailing && (
                    <span className="text-[0.625rem] text-muted-foreground ml-auto font-mono shrink-0">
                      {it.trailing}
                    </span>
                  )}
                </label>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ScopeSelector({
  scope,
  onChange,
  showRawPackets = false,
}: {
  scope: Record<string, unknown>;
  onChange: (scope: Record<string, unknown>) => void;
  showRawPackets?: boolean;
}) {
  useLingui();

  const { data: channels = [] } = useQuery({
    queryKey: queryKeys.channels(),
    queryFn: ({ signal }) => api.getChannels(signal),
  });
  const { data: contacts = [] } = useQuery({
    queryKey: queryKeys.contacts(),
    queryFn: ({ signal }) => fetchAllContacts(signal),
  });

  const messages = scope.messages ?? 'all';
  const rawMode = getScopeMode(messages);
  // When raw packets aren't offered, "none" is not a valid choice — treat as "all"
  const mode = !showRawPackets && rawMode === 'none' ? 'all' : rawMode;
  const isListMode = mode === 'only' || mode === 'except';

  const selectedChannels: string[] =
    isListMode && typeof messages === 'object' && messages !== null
      ? getFilterKeys((messages as Record<string, unknown>).channels)
      : [];
  const selectedContacts: string[] =
    isListMode && typeof messages === 'object' && messages !== null
      ? getFilterKeys((messages as Record<string, unknown>).contacts)
      : [];

  /** Wrap channel/contact key lists in the right shape for the current mode */
  const buildMessages = (chKeys: string[], coKeys: string[]) => {
    if (mode === 'except') {
      return {
        channels: { except: chKeys },
        contacts: { except: coKeys },
      };
    }
    return { channels: chKeys, contacts: coKeys };
  };

  const handleModeChange = (newMode: ScopeMode) => {
    if (newMode === 'all' || newMode === 'none') {
      onChange({ ...scope, messages: newMode });
    } else if (newMode === 'only') {
      onChange({ ...scope, messages: { channels: [], contacts: [] } });
    } else {
      onChange({
        ...scope,
        messages: { channels: { except: [] }, contacts: { except: [] } },
      });
    }
  };

  const toggleChannel = (key: string) => {
    const current = [...selectedChannels];
    const idx = current.indexOf(key);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(key);
    onChange({ ...scope, messages: buildMessages(current, selectedContacts) });
  };

  const toggleContact = (key: string) => {
    const current = [...selectedContacts];
    const idx = current.indexOf(key);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(key);
    onChange({ ...scope, messages: buildMessages(selectedChannels, current) });
  };

  // Exclude repeaters (2), rooms (3), and sensors (4)
  const filteredContacts = contacts.filter((c) => c.type === 0 || c.type === 1);

  const modeDescriptions: Record<ScopeMode, string> = {
    all: 'All messages',
    none: 'No messages',
    only: 'Only listed channels/contacts',
    except: 'All except listed channels/contacts',
  };

  const rawEnabled = showRawPackets && scope.raw_packets === 'all';

  // Warn when the effective scope matches nothing
  const messagesEffectivelyNone =
    mode === 'none' ||
    (mode === 'only' && selectedChannels.length === 0 && selectedContacts.length === 0) ||
    (mode === 'except' &&
      channels.length > 0 &&
      filteredContacts.length > 0 &&
      selectedChannels.length >= channels.length &&
      selectedContacts.length >= filteredContacts.length);
  const showEmptyScopeWarning = messagesEffectivelyNone && !rawEnabled;

  const listHint =
    mode === 'only'
      ? 'Newly added channels or contacts will not be automatically included.'
      : 'Newly added channels or contacts will be automatically included unless excluded here.';

  const checkboxLabel = mode === 'except' ? 'exclude' : 'include';

  const messageModes: ScopeMode[] = showRawPackets
    ? ['all', 'none', 'only', 'except']
    : ['all', 'only', 'except'];

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold tracking-tight">
        <Trans>Message Scope</Trans>
      </h3>

      {showRawPackets && (
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={rawEnabled}
            onChange={(e) => onChange({ ...scope, raw_packets: e.target.checked ? 'all' : 'none' })}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm">
            <Trans>Forward raw packets</Trans>
          </span>
        </label>
      )}

      <div className="space-y-1">
        {messageModes.map((m) => (
          <label key={m} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="scope-mode"
              checked={mode === m}
              onChange={() => handleModeChange(m)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">{modeDescriptions[m]}</span>
          </label>
        ))}
      </div>

      {showEmptyScopeWarning && (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
          <Trans>Nothing is selected &mdash; this integration will not forward any data.</Trans>
        </div>
      )}

      {isListMode && (
        <>
          <p className="text-[0.8125rem] text-muted-foreground">{listHint}</p>

          {channels.length > 0 && (
            <PillsSearchList
              label={t`Channels`}
              labelSuffix={checkboxLabel}
              items={channels.map((ch) => ({ key: ch.key, label: ch.name }))}
              selectedKeys={selectedChannels}
              onToggle={toggleChannel}
              onAll={() =>
                onChange({
                  ...scope,
                  messages: buildMessages(
                    channels.map((ch) => ch.key),
                    selectedContacts
                  ),
                })
              }
              onNone={() => onChange({ ...scope, messages: buildMessages([], selectedContacts) })}
              searchPlaceholder={`Search ${channels.length} channel${channels.length === 1 ? '' : 's'}...`}
              emptyItemsMessage="No channels available."
            />
          )}

          {filteredContacts.length > 0 && (
            <PillsSearchList
              label={t`Contacts`}
              labelSuffix={checkboxLabel}
              items={filteredContacts.map((c) => ({
                key: c.public_key,
                label: c.name || c.public_key.slice(0, 12),
                trailing: c.public_key.slice(0, 12),
              }))}
              selectedKeys={selectedContacts}
              onToggle={toggleContact}
              onAll={() =>
                onChange({
                  ...scope,
                  messages: buildMessages(
                    selectedChannels,
                    filteredContacts.map((c) => c.public_key)
                  ),
                })
              }
              onNone={() => onChange({ ...scope, messages: buildMessages(selectedChannels, []) })}
              searchPlaceholder={`Search ${filteredContacts.length} contact${filteredContacts.length === 1 ? '' : 's'}...`}
              emptyItemsMessage="No contacts available."
            />
          )}
        </>
      )}
    </div>
  );
}

const APPRISE_DEFAULT_DM = '**DM:** {sender_name}: {text} **via:** [{hops_backticked}]';
const APPRISE_DEFAULT_CHANNEL =
  '**{channel_name}:** {sender_name}: {text} **via:** [{hops_backticked}]';
const APPRISE_DEFAULT_DM_PLAIN = 'DM: {sender_name}: {text} via: [{hops}]';
const APPRISE_DEFAULT_CHANNEL_PLAIN = '{channel_name}: {sender_name}: {text} via: [{hops}]';

const APPRISE_SAMPLE_VARS: Record<string, string> = {
  type: 'CHAN',
  text: 'hello world',
  sender_name: 'Alice',
  sender_key: 'a1b2c3d4e5f6',
  channel_name: '#general',
  conversation_key: 'abcdef1234567890',
  hops: '2a, 3b',
  hops_backticked: '`2a`, `3b`',
  hop_count: '2',
  rssi: '-95',
  snr: '6.5',
};

const APPRISE_SAMPLE_VARS_DM: Record<string, string> = {
  ...APPRISE_SAMPLE_VARS,
  type: 'PRIV',
  channel_name: '',
  conversation_key: 'a1b2c3d4e5f6',
};

function appriseApplyFormat(fmt: string, vars: Record<string, string>): string {
  let result = fmt;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{${key}}`).join(value);
  }
  return result;
}

/** Render a markdown-ish string into inline React elements (bold, italic, code). */
function appriseRenderMarkdown(s: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  // Split on **bold**, __bold__, *italic*, _italic_, and `code` spans.
  // Longer delimiters first so ** and __ match before * and _.
  const parts = s.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g);
  for (const part of parts) {
    if (
      (part.startsWith('**') && part.endsWith('**')) ||
      (part.startsWith('__') && part.endsWith('__'))
    ) {
      nodes.push(
        <strong key={key++} className="font-bold">
          {part.slice(2, -2)}
        </strong>
      );
    } else if (
      (part.startsWith('*') && part.endsWith('*')) ||
      (part.startsWith('_') && part.endsWith('_'))
    ) {
      nodes.push(
        <em key={key++} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 text-[0.6875rem] font-mono">
          {part.slice(1, -1)}
        </code>
      );
    } else if (part) {
      nodes.push(<span key={key++}>{part}</span>);
    }
  }
  return nodes;
}

function AppriseFormatPreview({
  format,
  vars,
  markdown = true,
}: {
  format: string;
  vars: Record<string, string>;
  markdown?: boolean;
}) {
  useLingui();

  const raw = appriseApplyFormat(format, vars);
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1.5">
      {markdown && (
        <div>
          <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
            <Trans>Rendered (Discord, Slack, Telegram)</Trans>
          </span>
          <p className="text-xs break-all">{appriseRenderMarkdown(raw)}</p>
        </div>
      )}
      <div>
        <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
          {markdown ? t`Raw (email, SMS)` : t`Preview`}
        </span>
        <p className="text-xs font-mono break-all text-muted-foreground">{raw}</p>
      </div>
    </div>
  );
}

function appriseIsDefault(value: unknown, defaultStr: string): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  return s === '' || s === defaultStr;
}

function AppriseConfigEditor({
  config,
  scope,
  onChange,
  onScopeChange,
}: {
  config: Record<string, unknown>;
  scope: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onScopeChange: (scope: Record<string, unknown>) => void;
}) {
  useLingui();

  const markdown = config.markdown_format !== false;
  const defaultDm = markdown ? APPRISE_DEFAULT_DM : APPRISE_DEFAULT_DM_PLAIN;
  const defaultChan = markdown ? APPRISE_DEFAULT_CHANNEL : APPRISE_DEFAULT_CHANNEL_PLAIN;
  const dmFormat = ((config.body_format_dm as string) || '').trim() || defaultDm;
  const chanFormat = ((config.body_format_channel as string) || '').trim() || defaultChan;

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Send push notifications via{' '}
          <a
            href="https://github.com/caronc/apprise"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Apprise
          </a>{' '}
          when messages are received. Supports Discord, Slack, Telegram, email, and{' '}
          <a
            href="https://github.com/caronc/apprise/wiki#supported-notifications"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            100+ other services
          </a>
          .
        </Trans>
      </p>

      <div className="space-y-2">
        <Label htmlFor="fanout-apprise-urls">
          <Trans>Notification URLs</Trans>
        </Label>
        <textarea
          id="fanout-apprise-urls"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px]"
          placeholder={t`discord://webhook_id/token\nslack://token_a/token_b/token_c\ntgram://bot_token/chat_id`}
          value={(config.urls as string) || ''}
          onChange={(e) => onChange({ ...config, urls: e.target.value })}
          rows={4}
        />
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            One URL per line. All URLs receive every matched notification. For Matrix room version
            12 (servername-less room IDs), append <code>?hsreq=no</code> to the URL.
          </Trans>
        </p>
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={config.preserve_identity !== false}
          onChange={(e) => onChange({ ...config, preserve_identity: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <div>
          <span className="text-sm">
            <Trans>Preserve identity on Discord</Trans>
          </span>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              When enabled, Discord webhooks will use their configured name/avatar instead of
              overriding with MeshCore sender info.
            </Trans>
          </p>
        </div>
      </label>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={config.include_outgoing === true}
          onChange={(e) => onChange({ ...config, include_outgoing: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        <div>
          <span className="text-sm">
            <Trans>Forward MESHRIK-sent messages</Trans>
          </span>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              Include DMs and channel messages sent by this MESHRIK instance, including manual sends
              and bot replies. Outgoing messages carry no routing path or signal data, so
              path-related format fields render as direct and RSSI/SNR are empty.
            </Trans>
          </p>
        </div>
      </label>

      <Separator />

      <h3 className="text-base font-semibold tracking-tight">
        <Trans>Message Format</Trans>
      </h3>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={markdown}
          onChange={(e) => {
            const md = e.target.checked;
            const updates: Record<string, unknown> = { ...config, markdown_format: md };
            const curDm = ((config.body_format_dm as string) || '').trim();
            const curChan = ((config.body_format_channel as string) || '').trim();
            if (md) {
              if (!curDm || curDm === APPRISE_DEFAULT_DM_PLAIN)
                updates.body_format_dm = APPRISE_DEFAULT_DM;
              if (!curChan || curChan === APPRISE_DEFAULT_CHANNEL_PLAIN)
                updates.body_format_channel = APPRISE_DEFAULT_CHANNEL;
            } else {
              if (!curDm || curDm === APPRISE_DEFAULT_DM)
                updates.body_format_dm = APPRISE_DEFAULT_DM_PLAIN;
              if (!curChan || curChan === APPRISE_DEFAULT_CHANNEL)
                updates.body_format_channel = APPRISE_DEFAULT_CHANNEL_PLAIN;
            }
            onChange(updates);
          }}
          className="h-4 w-4 rounded border-border"
        />
        <div>
          <span className="text-sm">
            <Trans>Markdown formatting</Trans>
          </span>
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>
              If notifications fail on services like Telegram due to special characters in sender
              names, disable this option.
            </Trans>
          </p>
        </div>
      </label>

      <details className="group">
        <summary className="text-sm font-medium text-foreground cursor-pointer select-none flex items-center gap-1">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
          <Trans>Available variables</Trans>
        </summary>
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs space-y-0.5">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">{t`{text}`}</code>
            <span className="text-muted-foreground">
              <Trans>Message body</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{sender_name}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Sender display name</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{sender_key}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Sender public key (hex)</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{channel_name}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Channel name (channel messages only)</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{conversation_key}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Contact pubkey (DM) or channel key (channel)</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">{t`{type}`}</code>
            <span className="text-muted-foreground">
              <Trans>PRIV or CHAN</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">{t`{hops}`}</code>
            <span className="text-muted-foreground">
              <Trans>Comma-separated hop IDs, or &quot;direct&quot;</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{hops_backticked}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Hops wrapped in backticks for markdown</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">
              {t`{hop_count}`}
            </code>
            <span className="text-muted-foreground">
              <Trans>Number of hops (0 for direct)</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">{t`{rssi}`}</code>
            <span className="text-muted-foreground">
              <Trans>Last-hop RSSI in dBm</Trans>
            </span>
            <code className="text-[0.6875rem] font-mono bg-muted px-1 rounded">{t`{snr}`}</code>
            <span className="text-muted-foreground">
              <Trans>Last-hop SNR in dB</Trans>
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            <Trans>
              Empty textareas use the default format. RSSI/SNR may be empty if unavailable.
            </Trans>
          </p>
        </div>
      </details>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="fanout-apprise-fmt-dm">
            <Trans>DM format</Trans>
          </Label>
          {!appriseIsDefault(config.body_format_dm, defaultDm) && (
            <button
              type="button"
              aria-label={t`Reset DM format to default`}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => onChange({ ...config, body_format_dm: defaultDm })}
            >
              <Trans>Reset to default</Trans>
            </button>
          )}
        </div>
        <textarea
          id="fanout-apprise-fmt-dm"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[56px]"
          placeholder={defaultDm}
          value={(config.body_format_dm as string) ?? ''}
          onChange={(e) => onChange({ ...config, body_format_dm: e.target.value })}
          rows={2}
        />
        <AppriseFormatPreview format={dmFormat} vars={APPRISE_SAMPLE_VARS_DM} markdown={markdown} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="fanout-apprise-fmt-chan">
            <Trans>Channel format</Trans>
          </Label>
          {!appriseIsDefault(config.body_format_channel, defaultChan) && (
            <button
              type="button"
              aria-label={t`Reset channel format to default`}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => onChange({ ...config, body_format_channel: defaultChan })}
            >
              <Trans>Reset to default</Trans>
            </button>
          )}
        </div>
        <textarea
          id="fanout-apprise-fmt-chan"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[56px]"
          placeholder={defaultChan}
          value={(config.body_format_channel as string) ?? ''}
          onChange={(e) => onChange({ ...config, body_format_channel: e.target.value })}
          rows={2}
        />
        <AppriseFormatPreview format={chanFormat} vars={APPRISE_SAMPLE_VARS} markdown={markdown} />
      </div>

      <Separator />

      <ScopeSelector scope={scope} onChange={onScopeChange} />
    </div>
  );
}

function WebhookConfigEditor({
  config,
  scope,
  onChange,
  onScopeChange,
}: {
  config: Record<string, unknown>;
  scope: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onScopeChange: (scope: Record<string, unknown>) => void;
}) {
  useLingui();

  const headersStr = JSON.stringify(config.headers ?? {}, null, 2);
  const headersForm = useForm({
    defaultValues: { text: headersStr, error: null as string | null },
  });
  const { text: headersText, error: headersError } = useStore(
    headersForm.store,
    (state) => state.values
  );

  const handleHeadersChange = (text: string) => {
    headersForm.setFieldValue('text', text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        headersForm.setFieldValue('error', t`Must be a JSON object`);
        return;
      }
      headersForm.setFieldValue('error', null);
      onChange({ ...config, headers: parsed });
    } catch {
      headersForm.setFieldValue('error', t`Invalid JSON`);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>Send message data as JSON to an HTTP endpoint when messages are received.</Trans>
      </p>

      <div className="space-y-2">
        <Label htmlFor="fanout-webhook-url">
          <Trans>URL</Trans>
        </Label>
        <Input
          id="fanout-webhook-url"
          type="url"
          placeholder="https://example.com/webhook"
          value={(config.url as string) || ''}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-webhook-method">
            <Trans>HTTP Method</Trans>
          </Label>
          <select
            id="fanout-webhook-method"
            value={(config.method as string) || `POST`}
            onChange={(e) => onChange({ ...config, method: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="POST">
              <Trans>POST</Trans>
            </option>
            <option value="PUT">
              <Trans>PUT</Trans>
            </option>
            <option value="PATCH">
              <Trans>PATCH</Trans>
            </option>
          </select>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>HMAC Signing</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>
            When a secret is set, each request includes an HMAC-SHA256 signature of the JSON body in
            the specified header (e.g.{' '}
            <code className="bg-muted px-1 rounded">sha256=ab12cd...</code>
            ).
          </Trans>
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="fanout-webhook-hmac-secret">
              <Trans>HMAC Secret</Trans>
            </Label>
            <Input
              id="fanout-webhook-hmac-secret"
              type="password"
              placeholder={t`Leave empty to disable signing`}
              value={(config.hmac_secret as string) || ''}
              onChange={(e) => onChange({ ...config, hmac_secret: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fanout-webhook-hmac-header">
              <Trans>Signature Header Name</Trans>
            </Label>
            <Input
              id="fanout-webhook-hmac-header"
              type="text"
              placeholder={t`X-Webhook-Signature`}
              value={(config.hmac_header as string) || ''}
              onChange={(e) => onChange({ ...config, hmac_header: e.target.value })}
            />
          </div>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label htmlFor="fanout-webhook-headers">
          <Trans>Extra Headers (JSON)</Trans>
        </Label>
        <textarea
          id="fanout-webhook-headers"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[60px]"
          value={headersText}
          onChange={(e) => handleHeadersChange(e.target.value)}
          placeholder={t`{"Authorization": "Bearer ..."}`}
          aria-invalid={headersError ? true : undefined}
          aria-describedby={headersError ? `fanout-webhook-headers-error` : undefined}
        />
        {headersError && (
          <p id="fanout-webhook-headers-error" className="text-xs text-destructive" role="alert">
            {headersError}
          </p>
        )}
      </div>

      <Separator />

      <ScopeSelector scope={scope} onChange={onScopeChange} />
    </div>
  );
}

function SqsConfigEditor({
  config,
  scope,
  onChange,
  onScopeChange,
}: {
  config: Record<string, unknown>;
  scope: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onScopeChange: (scope: Record<string, unknown>) => void;
}) {
  useLingui();

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Send matched mesh events to an Amazon SQS queue for durable processing by workers,
          Lambdas, or downstream automation.
        </Trans>
      </p>

      <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
        <Trans>
          Outgoing messages and any selected raw packets will be delivered exactly as forwarded by
          the fanout scope, including decrypted/plaintext message content.
        </Trans>
      </div>

      <div className="space-y-2">
        <Label htmlFor="fanout-sqs-queue-url">
          <Trans>Queue URL</Trans>
        </Label>
        <Input
          id="fanout-sqs-queue-url"
          type="url"
          placeholder="https://sqs.us-east-1.amazonaws.com/123456789012/mesh-events"
          value={(config.queue_url as string) || ''}
          onChange={(e) => onChange({ ...config, queue_url: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-sqs-region">
            <Trans>Region (optional)</Trans>
          </Label>
          <Input
            id="fanout-sqs-region"
            type="text"
            placeholder={t`us-east-1`}
            value={(config.region_name as string) || ''}
            onChange={(e) => onChange({ ...config, region_name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-sqs-endpoint">
            <Trans>Endpoint URL (optional)</Trans>
          </Label>
          <Input
            id="fanout-sqs-endpoint"
            type="url"
            placeholder="http://localhost:4566"
            value={(config.endpoint_url as string) || ''}
            onChange={(e) => onChange({ ...config, endpoint_url: e.target.value })}
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            <Trans>Useful for LocalStack or custom endpoints</Trans>
          </p>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <h3 className="text-base font-semibold tracking-tight">
          <Trans>Static Credentials (optional)</Trans>
        </h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <Trans>Leave blank to use the server&apos;s normal AWS credential chain.</Trans>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="fanout-sqs-access-key">
            <Trans>Access Key ID</Trans>
          </Label>
          <Input
            id="fanout-sqs-access-key"
            type="text"
            value={(config.access_key_id as string) || ''}
            onChange={(e) => onChange({ ...config, access_key_id: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fanout-sqs-secret-key">
            <Trans>Secret Access Key</Trans>
          </Label>
          <Input
            id="fanout-sqs-secret-key"
            type="password"
            value={(config.secret_access_key as string) || ''}
            onChange={(e) => onChange({ ...config, secret_access_key: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="fanout-sqs-session-token">
          <Trans>Session Token (optional)</Trans>
        </Label>
        <Input
          id="fanout-sqs-session-token"
          type="password"
          value={(config.session_token as string) || ''}
          onChange={(e) => onChange({ ...config, session_token: e.target.value })}
        />
      </div>

      <Separator />

      <ScopeSelector scope={scope} onChange={onScopeChange} showRawPackets />
    </div>
  );
}

export function SettingsFanoutSection({
  health,
  onHealthRefresh,
  className,
}: {
  health: HealthStatus | null;
  onHealthRefresh?: () => Promise<void>;
  className?: string;
}) {
  useLingui();

  const queryClient = useQueryClient();
  const { data: configs = [] } = useQuery({
    queryKey: FANOUT_CONFIGS_QUERY_KEY,
    queryFn: () => api.getFanoutConfigs(),
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [errorDialogState, setErrorDialogState] = useState<{
    integrationName: string;
    error: string;
  } | null>(null);
  const saveConfigMutation = useMutation({
    mutationFn: (
      operation:
        | { kind: 'create'; payload: Parameters<typeof api.createFanoutConfig>[0] }
        | {
            kind: 'update';
            id: string;
            payload: Parameters<typeof api.updateFanoutConfig>[1];
          }
    ) =>
      operation.kind === 'create'
        ? api.createFanoutConfig(operation.payload)
        : api.updateFanoutConfig(operation.id, operation.payload),
    retry: false,
  });
  const renameConfigMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.updateFanoutConfig(id, { name }),
    retry: false,
  });
  const toggleConfigMutation = useMutation({
    mutationFn: (cfg: FanoutConfig) => api.updateFanoutConfig(cfg.id, { enabled: !cfg.enabled }),
    retry: false,
  });
  const deleteConfigMutation = useMutation({
    mutationFn: (id: string) => api.deleteFanoutConfig(id),
    retry: false,
  });
  const refreshConfigs = () =>
    queryClient.invalidateQueries({ queryKey: FANOUT_CONFIGS_QUERY_KEY });
  const editForm = useForm({
    defaultValues: {
      draftType: null as DraftType | null,
      config: {} as Record<string, unknown>,
      scope: {} as Record<string, unknown>,
      name: '',
      enabled: true,
      serverError: null as string | null,
    },
    onSubmit: async ({ value }) => {
      if (!editingId && !value.draftType) return;
      editForm.setFieldValue('serverError', null);
      if (!value.name.trim()) {
        editForm.setFieldValue('serverError', t`Name cannot be empty`);
        toast.error(t`Name cannot be empty`);
        return;
      }
      try {
        if (value.draftType) {
          const recipe = getCreateIntegrationDefinition(value.draftType);
          await saveConfigMutation.mutateAsync({
            kind: 'create',
            payload: {
              type: recipe.savedType,
              name: normalizeDraftName(value.draftType, value.name.trim(), configs),
              config: normalizeDraftConfig(value.draftType, value.config),
              scope: normalizeDraftScope(value.draftType, value.scope),
              enabled: value.enabled,
            },
          });
        } else {
          if (!editingId) throw new Error(t`Missing fanout config id for update`);
          const editingType = configs.find((cfg) => cfg.id === editingId)?.type ?? '';
          await saveConfigMutation.mutateAsync({
            kind: 'update',
            id: editingId,
            payload: {
              name: value.name,
              config: normalizeIntegrationConfigForSave(editingType, value.config),
              scope: value.scope,
              enabled: value.enabled,
            },
          });
        }
        editForm.reset();
        setEditingId(null);
        await refreshConfigs();
        if (onHealthRefresh) {
          try {
            await onHealthRefresh();
          } catch (err) {
            console.error('Failed to refresh health after saving fanout config:', err);
          }
        }
        toast.success(value.enabled ? t`Integration saved and enabled` : t`Integration saved`);
      } catch (err) {
        const message = err instanceof Error ? err.message : t`Failed to save`;
        editForm.setFieldValue('serverError', message);
        toast.error(message);
      }
    },
  });
  const editValues = useStore(editForm.store, (state) => state.values);
  const busy = useStore(editForm.store, (state) => state.isSubmitting);
  const draftType = editValues.draftType;
  const editConfig = editValues.config;
  const editScope = editValues.scope;
  const editName = editValues.name;
  const editServerError = editValues.serverError;
  const setEditConfig = (config: Record<string, unknown>) =>
    editForm.setFieldValue('config', config);
  const setEditScope = (scope: Record<string, unknown>) => editForm.setFieldValue('scope', scope);

  const inlineNameForm = useForm({
    defaultValues: { targetId: null as string | null, name: '' },
    onSubmit: async ({ value }) => {
      if (!value.targetId) return;
      const cfg = configs.find((candidate) => candidate.id === value.targetId);
      if (!cfg) return;
      const nextName = value.name.trim();
      if (!nextName) {
        toast.error(t`Name cannot be empty`);
        handleCancelInlineEdit();
        return;
      }
      if (nextName === cfg.name) {
        handleCancelInlineEdit();
        return;
      }
      try {
        await renameConfigMutation.mutateAsync({ id: cfg.id, name: nextName });
        if (editingId === cfg.id) editForm.setFieldValue('name', nextName);
        await refreshConfigs();
        toast.success(t`Name updated`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t`Failed to update name`);
      } finally {
        handleCancelInlineEdit();
      }
    },
  });
  const inlineEditName = useStore(inlineNameForm.store, (state) => state.values.name);

  const createForm = useForm({
    defaultValues: { selectedType: null as DraftType | null },
  });
  const selectedCreateType = useStore(createForm.store, (state) => state.values.selectedType);

  const availableCreateOptions = useMemo(
    () =>
      CREATE_INTEGRATION_DEFINITIONS.filter(
        (definition) =>
          (definition.savedType !== 'bot' || !health?.bots_disabled) &&
          (definition.savedType !== 'virtual_companion_tcp' ||
            !configs.some((cfg) => cfg.type === 'virtual_companion_tcp'))
      ),
    [configs, health?.bots_disabled]
  );

  useEffect(() => {
    if (!createDialogOpen) return;
    if (availableCreateOptions.length === 0) {
      createForm.setFieldValue('selectedType', null);
      return;
    }
    if (
      selectedCreateType &&
      availableCreateOptions.some((option) => option.value === selectedCreateType)
    ) {
      return;
    }
    createForm.setFieldValue('selectedType', availableCreateOptions[0].value);
  }, [createDialogOpen, availableCreateOptions, createForm, selectedCreateType]);

  const handleToggleEnabled = async (cfg: FanoutConfig) => {
    if (
      cfg.type === 'virtual_companion_tcp' &&
      cfg.enabled &&
      !confirm(
        t`Disable the virtual listener and disconnect its app clients? The physical radio and scheduled jobs will keep running.`
      )
    ) {
      return;
    }
    try {
      await toggleConfigMutation.mutateAsync(cfg);
      await refreshConfigs();
      if (onHealthRefresh) {
        try {
          await onHealthRefresh();
        } catch (err) {
          console.error('Failed to refresh health after toggling fanout config:', err);
        }
      }
      toast.success(cfg.enabled ? t`Integration disabled` : t`Integration enabled`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Failed to update`);
    }
  };

  const handleEdit = (cfg: FanoutConfig) => {
    setCreateDialogOpen(false);
    setInlineEditingId(null);
    inlineNameForm.reset();
    setEditingId(cfg.id);
    editForm.reset();
    editForm.setFieldValue('config', cfg.config);
    editForm.setFieldValue('scope', cfg.scope);
    editForm.setFieldValue('name', cfg.name);
    editForm.setFieldValue('enabled', cfg.enabled);
  };

  const handleStartInlineEdit = (cfg: FanoutConfig) => {
    setCreateDialogOpen(false);
    setInlineEditingId(cfg.id);
    inlineNameForm.reset();
    inlineNameForm.setFieldValue('targetId', cfg.id);
    inlineNameForm.setFieldValue('name', cfg.name);
  };

  const handleCancelInlineEdit = () => {
    setInlineEditingId(null);
    inlineNameForm.reset();
  };

  const handleBackToList = () => {
    const shouldConfirm =
      draftType !== null ||
      fanoutDraftHasUnsavedChanges(
        editingId ? (configs.find((c) => c.id === editingId) ?? null) : null,
        {
          name: editName,
          config: editConfig,
          scope: editScope,
        }
      );
    if (shouldConfirm && !confirm(t`Leave without saving?`)) return;
    setEditingId(null);
    editForm.reset();
  };

  const handleInlineNameSave = async (cfg: FanoutConfig) => {
    if (inlineEditingId !== cfg.id) return;
    await inlineNameForm.handleSubmit();
  };

  const handleSave = (enabled: boolean) => {
    editForm.setFieldValue('enabled', enabled);
    void editForm.handleSubmit();
  };

  const handleDelete = async (id: string) => {
    const cfg = configs.find((c) => c.id === id);
    const configName = cfg?.name ?? t`this integration`;
    const warning =
      cfg?.type === 'virtual_companion_tcp'
        ? t`Delete "${cfg.name}" and disconnect its virtual app clients? The physical radio and scheduled jobs will keep running. This cannot be undone.`
        : t`Delete "${configName}"? This cannot be undone.`;
    if (!confirm(warning)) return;
    try {
      await deleteConfigMutation.mutateAsync(id);
      if (editingId === id) setEditingId(null);
      await refreshConfigs();
      if (onHealthRefresh) {
        try {
          await onHealthRefresh();
        } catch (err) {
          console.error('Failed to refresh health after deleting fanout config:', err);
        }
      }
      toast.success(t`Integration deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Failed to delete`);
    }
  };

  const handleAddCreate = (type: DraftType) => {
    const definition = getCreateIntegrationDefinition(type);
    const defaults = cloneDraftDefaults(type);
    setCreateDialogOpen(false);
    setEditingId(null);
    editForm.reset();
    editForm.setFieldValue('draftType', type);
    editForm.setFieldValue(
      'name',
      definition.nameMode === 'fixed'
        ? definition.defaultName
        : getDefaultIntegrationName(definition.savedType, configs)
    );
    editForm.setFieldValue('config', defaults.config);
    editForm.setFieldValue('scope', defaults.scope);
    editForm.setFieldValue('enabled', definition.defaultEnabled ?? true);
  };

  const editingConfig = editingId ? configs.find((c) => c.id === editingId) : null;
  const detailType = draftType ?? editingConfig?.type ?? null;
  const isDraft = draftType !== null;
  const configGroups = Object.entries(TYPE_LABELS)
    .map(([type, label]) => ({
      type,
      label,
      configs: configs
        .filter((cfg) => cfg.type === type)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }))
    .filter((group) => group.configs.length > 0);

  // Detail view
  if (detailType) {
    return (
      <div className={cn('mx-auto w-full max-w-[800px] space-y-4', className)}>
        <button
          type="button"
          className="inline-flex items-center rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning transition-colors hover:bg-warning/20"
          onClick={handleBackToList}
        >
          <Trans>&larr; Back to list</Trans>
        </button>

        <div className="space-y-2">
          <Label htmlFor="fanout-edit-name">
            <Trans>Name</Trans>
          </Label>
          <Input
            id="fanout-edit-name"
            type="text"
            value={editName}
            onChange={(e) => editForm.setFieldValue('name', e.target.value)}
            aria-invalid={editServerError ? true : undefined}
            aria-describedby={editServerError ? `fanout-save-error` : undefined}
          />
        </div>

        <div className="text-xs text-muted-foreground">
          <Trans>Type: {getDetailTypeLabel(detailType)}</Trans>
        </div>

        <Separator />

        {detailType === 'mqtt_private' && (
          <MqttPrivateConfigEditor
            config={editConfig}
            scope={editScope}
            onChange={setEditConfig}
            onScopeChange={setEditScope}
          />
        )}

        {detailType === 'virtual_companion_tcp' && (
          <VirtualCompanionConfigEditor
            config={editConfig}
            onChange={setEditConfig}
            status={editingId ? health?.fanout_statuses?.[editingId] : undefined}
            radioConnected={health?.radio_connected ?? false}
          />
        )}

        {detailType === 'mqtt_ha' && (
          <MqttHaConfigEditor
            config={editConfig}
            scope={editScope}
            onChange={setEditConfig}
            onScopeChange={setEditScope}
          />
        )}

        {detailType === 'mqtt_community' && (
          <MqttCommunityConfigEditor config={editConfig} onChange={setEditConfig} />
        )}

        {detailType === 'mqtt_community_meshrank' && (
          <MeshRankConfigEditor config={editConfig} onChange={setEditConfig} />
        )}

        {detailType === 'mqtt_community_letsmesh_us' && (
          <LetsMeshConfigEditor
            config={editConfig}
            onChange={setEditConfig}
            brokerHost={DEFAULT_COMMUNITY_BROKER_HOST}
          />
        )}

        {detailType === 'mqtt_community_letsmesh_eu' && (
          <LetsMeshConfigEditor
            config={editConfig}
            onChange={setEditConfig}
            brokerHost={DEFAULT_COMMUNITY_BROKER_HOST_EU}
          />
        )}

        {detailType === 'bot' && <BotConfigEditor config={editConfig} onChange={setEditConfig} />}

        {detailType === 'apprise' && (
          <AppriseConfigEditor
            config={editConfig}
            scope={editScope}
            onChange={setEditConfig}
            onScopeChange={setEditScope}
          />
        )}

        {detailType === 'webhook' && (
          <WebhookConfigEditor
            config={editConfig}
            scope={editScope}
            onChange={setEditConfig}
            onScopeChange={setEditScope}
          />
        )}

        {detailType === 'sqs' && (
          <SqsConfigEditor
            config={editConfig}
            scope={editScope}
            onChange={setEditConfig}
            onScopeChange={setEditScope}
          />
        )}

        {detailType === 'map_upload' && (
          <MapUploadConfigEditor config={editConfig} onChange={setEditConfig} />
        )}

        <Separator />

        {editServerError ? (
          <p id="fanout-save-error" className="text-sm text-destructive" role="alert">
            {editServerError}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button
            onClick={() => handleSave(true)}
            disabled={busy}
            className="flex-1 bg-status-connected hover:bg-status-connected/90 text-primary-foreground"
          >
            {busy ? t`Saving...` : t`Save as Enabled`}
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleSave(false)}
            disabled={busy}
            className="flex-1"
          >
            {busy ? t`Saving...` : t`Save as Disabled`}
          </Button>
          {!isDraft && editingConfig && (
            <Button variant="destructive" onClick={() => handleDelete(editingConfig.id)}>
              <Trans>Delete</Trans>
            </Button>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className={cn('mx-auto w-full max-w-[800px] space-y-4', className)}>
      <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
        <Trans>
          Integrations are an experimental feature in open beta, and allow you to fanout raw and
          decrypted messages across multiple services for automation, analysis, or archiving.
        </Trans>
      </div>

      {health?.bots_disabled && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {health.bots_disabled_source === 'until_restart'
            ? t`Bot system is disabled until the server restarts. Bot integrations cannot run, be created, or be modified right now.`
            : t`Bot system is disabled by server configuration (MESHCORE_DISABLE_BOTS). Bot integrations cannot run, be created, or be modified.`}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => setCreateDialogOpen(true)}>
          <Trans>Add Integration</Trans>
        </Button>
      </div>

      <CreateIntegrationDialog
        open={createDialogOpen}
        options={availableCreateOptions}
        selectedType={selectedCreateType}
        onOpenChange={setCreateDialogOpen}
        onSelect={(type) => createForm.setFieldValue('selectedType', type)}
        onCreate={() => {
          if (selectedCreateType) {
            handleAddCreate(selectedCreateType);
          }
        }}
      />

      <Dialog
        open={errorDialogState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setErrorDialogState(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>
              {errorDialogState
                ? t`${errorDialogState.integrationName} Error`
                : t`Integration Error`}
            </DialogTitle>
            <DialogDescription>
              <Trans>Most recent backend error retained for this integration.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4 text-sm text-muted-foreground">
            <p className="whitespace-pre-wrap break-words font-mono text-foreground">
              {errorDialogState?.error}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {configGroups.length > 0 && (
        <div className="columns-1 gap-4 md:columns-2">
          {configGroups.map((group) => (
            <section
              key={group.type}
              className="mb-4 inline-block w-full break-inside-avoid space-y-2"
              aria-label={t`${group.label} integrations`}
            >
              <div className="px-1 text-sm font-medium text-muted-foreground">{group.label}</div>
              <div className="space-y-2">
                {group.configs.map((cfg) => {
                  const statusEntry = health?.fanout_statuses?.[cfg.id];
                  const status = cfg.enabled ? statusEntry?.status : undefined;
                  const lastError = cfg.enabled ? statusEntry?.last_error : null;
                  const communityConfig = cfg.config as Record<string, unknown>;
                  return (
                    <div
                      key={cfg.id}
                      role="group"
                      aria-label={t`Integration ${cfg.name}`}
                      className="border border-input rounded-md overflow-hidden"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50">
                        <label
                          className="flex items-center cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={cfg.enabled}
                            onChange={() => handleToggleEnabled(cfg)}
                            disabled={toggleConfigMutation.isPending}
                            className="w-4 h-4 rounded border-input accent-primary"
                            aria-label={t`Enable ${cfg.name}`}
                          />
                        </label>

                        <div className="flex-1 min-w-0">
                          {inlineEditingId === cfg.id ? (
                            <Input
                              value={inlineEditName}
                              autoFocus
                              onChange={(e) => inlineNameForm.setFieldValue('name', e.target.value)}
                              onFocus={(e) => e.currentTarget.select()}
                              onBlur={() => void handleInlineNameSave(cfg)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  e.currentTarget.blur();
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  handleCancelInlineEdit();
                                }
                              }}
                              aria-label={t`Edit name for ${cfg.name}`}
                              className="h-8"
                            />
                          ) : (
                            <button
                              type="button"
                              className="block max-w-full cursor-text truncate text-left text-sm font-medium hover:text-foreground/80"
                              onClick={() => handleStartInlineEdit(cfg)}
                            >
                              {cfg.name}
                            </button>
                          )}
                        </div>

                        <div
                          className={cn(
                            'w-2 h-2 rounded-full transition-colors',
                            getStatusColor(status, cfg.enabled)
                          )}
                          title={cfg.enabled ? getStatusLabel(status, cfg.type) : t`Disabled`}
                          aria-hidden="true"
                        />
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                          {cfg.enabled ? getStatusLabel(status, cfg.type) : t`Disabled`}
                        </span>

                        {lastError && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 px-0"
                            onClick={() =>
                              setErrorDialogState({
                                integrationName: cfg.name,
                                error: lastError,
                              })
                            }
                            aria-label={t`View error details for ${cfg.name}`}
                            title={t`View latest error`}
                          >
                            <Info className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => handleEdit(cfg)}
                        >
                          <Trans>Edit</Trans>
                        </Button>
                      </div>

                      {cfg.type === 'mqtt_community' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div>
                            <Trans>
                              Broker:{' '}
                              {formatBrokerSummary(communityConfig, {
                                host: DEFAULT_COMMUNITY_BROKER_HOST,
                                port: DEFAULT_COMMUNITY_BROKER_PORT,
                              })}
                            </Trans>
                          </div>
                          <div className="break-all">
                            <Trans>
                              Topic:{' '}
                              <code>
                                {(communityConfig.topic_template as string) ||
                                  DEFAULT_COMMUNITY_PACKET_TOPIC_TEMPLATE}
                              </code>
                            </Trans>
                          </div>
                        </div>
                      )}

                      {cfg.type === 'virtual_companion_tcp' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div>
                            <Trans>
                              Virtual endpoint:{' '}
                              <code>
                                {String(cfg.config.bind_host ?? '0.0.0.0')}:
                                {String(cfg.config.port ?? 5000)}
                              </code>
                            </Trans>
                          </div>
                          <div>
                            <Trans>
                              {health?.fanout_statuses?.[cfg.id]?.clients ?? 0} connected app client
                              {(health?.fanout_statuses?.[cfg.id]?.clients ?? 0) === 1
                                ? ''
                                : 's'} ·{' '}
                              {Array.isArray(cfg.config.channel_slots)
                                ? cfg.config.channel_slots.filter((key) => key !== null).length
                                : 0}{' '}
                              configured virtual slots
                            </Trans>
                          </div>
                        </div>
                      )}

                      {cfg.type === 'mqtt_private' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div>
                            <Trans>
                              Broker:{' '}
                              {formatBrokerSummary(cfg.config as Record<string, unknown>, {
                                host: '',
                                port: 1883,
                              })}
                            </Trans>
                          </div>
                          <div className="break-all">
                            <Trans>
                              Topics:{' '}
                              <code>
                                {formatPrivateTopicSummary(cfg.config as Record<string, unknown>)}
                              </code>
                            </Trans>
                          </div>
                        </div>
                      )}

                      {cfg.type === 'webhook' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div className="break-all">
                            <Trans>
                              URL:{' '}
                              <code>
                                {((cfg.config as Record<string, unknown>).url as string) ||
                                  'Not set'}
                              </code>
                            </Trans>
                          </div>
                        </div>
                      )}

                      {cfg.type === 'apprise' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div className="break-all">
                            <Trans>
                              Targets:{' '}
                              <code>
                                {formatAppriseTargets(
                                  (cfg.config as Record<string, unknown>).urls as string | undefined
                                )}
                              </code>
                            </Trans>
                          </div>
                        </div>
                      )}

                      {cfg.type === 'sqs' && (
                        <div className="space-y-1 border-t border-input px-3 py-2 text-xs text-muted-foreground">
                          <div className="break-all">
                            <Trans>
                              Queue:{' '}
                              <code>
                                {formatSqsQueueSummary(cfg.config as Record<string, unknown>)}
                              </code>
                            </Trans>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
