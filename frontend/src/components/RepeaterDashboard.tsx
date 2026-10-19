import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api';
import { copyTextWithFeedback } from '../utils/clipboard';
import { Button } from './ui/button';
import { Bell, Info, Route, Star, Trash2 } from 'lucide-react';
import { DirectTraceIcon } from './DirectTraceIcon';
import { RepeaterLogin } from './RepeaterLogin';
import { ServerLoginStatusBanner } from './ServerLoginStatusBanner';
import { useRememberedServerPassword } from '../hooks/useRememberedServerPassword';
import { useRepeaterDashboard } from '../hooks/useRepeaterDashboard';
import { isValidLocation } from '../utils/pathUtils';
import { ContactStatusInfo } from './ContactStatusInfo';
import type { Contact, Conversation, PathDiscoveryResponse, TelemetryHistoryEntry } from '../types';
import { cn } from '../lib/utils';
import { TelemetryPane } from './repeater/RepeaterTelemetryPane';
import { NeighborsPane } from './repeater/RepeaterNeighborsPane';
import { AclPane } from './repeater/RepeaterAclPane';
import { NodeInfoPane } from './repeater/RepeaterNodeInfoPane';
import { RadioSettingsPane } from './repeater/RepeaterRadioSettingsPane';
import { LppTelemetryPane } from './repeater/RepeaterLppTelemetryPane';
import { OwnerInfoPane } from './repeater/RepeaterOwnerInfoPane';
import { RegionsPane } from './repeater/RepeaterRegionsPane';
import { ActionsPane } from './repeater/RepeaterActionsPane';
import { ConsolePane } from './repeater/RepeaterConsolePane';
import { TelemetryHistoryPane } from './repeater/RepeaterTelemetryHistoryPane';
import { ContactPathDiscoveryModal } from './ContactPathDiscoveryModal';

// Re-export for backwards compatibility (used by repeaterFormatters.test.ts)
export { formatDuration, formatClockDrift } from './repeater/repeaterPaneShared';

// --- Main Dashboard ---

interface RepeaterDashboardProps {
  conversation: Conversation;
  contacts: Contact[];
  notificationsSupported: boolean;
  notificationsEnabled: boolean;
  notificationsPermission: NotificationPermission | 'unsupported';
  radioLat: number | null;
  radioLon: number | null;
  radioName: string | null;
  onTrace: () => void;
  onPathDiscovery: (publicKey: string) => Promise<PathDiscoveryResponse>;
  onToggleNotifications: () => void;
  onToggleFavorite: (type: 'channel' | 'contact', id: string) => void;
  onDeleteContact: (publicKey: string) => void;
  onOpenContactInfo?: (publicKey: string) => void;
  trackedTelemetryRepeaters: string[];
  onToggleTrackedTelemetry: (publicKey: string) => Promise<void>;
  autoLoginAndLoadAll?: boolean;
  onAutoLoginConsumed?: () => void;
}

export function RepeaterDashboard({
  conversation,
  contacts,
  notificationsSupported,
  notificationsEnabled,
  notificationsPermission,
  radioLat,
  radioLon,
  radioName,
  onTrace,
  onPathDiscovery,
  onToggleNotifications,
  onToggleFavorite,
  onDeleteContact,
  onOpenContactInfo,
  trackedTelemetryRepeaters,
  onToggleTrackedTelemetry,
  autoLoginAndLoadAll,
  onAutoLoginConsumed,
}: RepeaterDashboardProps) {
  const [pathDiscoveryOpen, setPathDiscoveryOpen] = useState(false);
  const contact = contacts.find((c) => c.public_key === conversation.id) ?? null;
  const hasAdvertLocation = isValidLocation(contact?.lat ?? null, contact?.lon ?? null);
  const {
    loggedIn,
    loginLoading,
    loginError,
    lastLoginAttempt,
    paneData,
    paneStates,
    consoleHistory,
    consoleLoading,
    login,
    loginAsGuest,
    refreshPane,
    loadAll,
    sendConsoleCommand,
    sendZeroHopAdvert,
    sendFloodAdvert,
    rebootRepeater,
    syncClock,
  } = useRepeaterDashboard(conversation, { hasAdvertLocation });
  const { password, rememberPassword, recordLoginAttempt, persistConfirmedPassword } =
    useRememberedServerPassword('repeater', conversation.id);

  // Telemetry history: preload from stored data, refresh from live status
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryHistoryEntry[]>([]);
  const [telemetryHistoryLoading, setTelemetryHistoryLoading] = useState(false);
  const [telemetryHistoryError, setTelemetryHistoryError] = useState<string | null>(null);
  const telemetryHistorySourceRef = useRef<'none' | 'preload' | 'live'>('none');
  const telemetryHistoryRequestRef = useRef(0);

  const loadTelemetryHistory = useCallback(() => {
    const requestId = ++telemetryHistoryRequestRef.current;
    setTelemetryHistoryLoading(true);
    setTelemetryHistoryError(null);
    void api
      .repeaterTelemetryHistory(conversation.id)
      .then((history) => {
        if (telemetryHistoryRequestRef.current !== requestId) return;
        setTelemetryHistoryLoading(false);
        if (telemetryHistorySourceRef.current === 'live') return;
        telemetryHistorySourceRef.current = 'preload';
        setTelemetryHistory(history);
      })
      .catch(() => {
        if (telemetryHistoryRequestRef.current !== requestId) return;
        setTelemetryHistoryLoading(false);
        setTelemetryHistoryError('Could not load saved telemetry');
      });
  }, [conversation.id]);

  useEffect(() => {
    telemetryHistoryRequestRef.current += 1;
    telemetryHistorySourceRef.current = 'none';
    setTelemetryHistory([]);
    setTelemetryHistoryLoading(false);
    setTelemetryHistoryError(null);

    if (!loggedIn) return;
    loadTelemetryHistory();
  }, [loggedIn, conversation.id, loadTelemetryHistory]);

  // When a live status fetch returns embedded telemetry_history, replace local state
  useEffect(() => {
    const liveHistory = paneData.status?.telemetry_history;
    if (!liveHistory) return;
    telemetryHistorySourceRef.current = 'live';
    setTelemetryHistory(liveHistory);
  }, [paneData.status?.telemetry_history]);

  // Command palette "ACL login + load all" auto-action
  const autoLoginConsumedRef = useRef(false);
  useEffect(() => {
    if (!autoLoginAndLoadAll || autoLoginConsumedRef.current) return;
    autoLoginConsumedRef.current = true;
    onAutoLoginConsumed?.();
    void loginAsGuest().then(() => loadAll());
  }, [autoLoginAndLoadAll, onAutoLoginConsumed, loginAsGuest, loadAll]);

  const isFav = contact?.favorite ?? false;

  const handleRepeaterLogin = async (nextPassword: string, shouldRemember = rememberPassword) => {
    recordLoginAttempt(nextPassword, shouldRemember);
    if (await login(nextPassword)) {
      persistConfirmedPassword(nextPassword, shouldRemember);
    }
  };
  const handleRepeaterGuestLogin = async () => {
    await loginAsGuest();
  };

  // Loading all panes indicator
  const anyLoading = Object.values(paneStates).some((s) => s.loading);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <header
        className={cn(
          'grid items-start gap-x-2 gap-y-0.5 border-b border-border px-4 py-2.5',
          contact
            ? 'grid-cols-[minmax(0,1fr)_auto] min-[1100px]:grid-cols-[minmax(0,1fr)_auto_auto]'
            : 'grid-cols-[minmax(0,1fr)_auto]'
        )}
      >
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <h2 className="min-w-0 flex-shrink font-semibold text-base">
                {onOpenContactInfo ? (
                  <button
                    type="button"
                    className="flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-sm text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`View info for ${conversation.name}`}
                    onClick={() => onOpenContactInfo(conversation.id)}
                  >
                    <span className="truncate">{conversation.name}</span>
                    <Info
                      className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80"
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <span className="truncate">{conversation.name}</span>
                )}
              </h2>
              <button
                type="button"
                className="max-w-32 truncate rounded text-left font-mono text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void copyTextWithFeedback(conversation.id, 'Contact key copied!')}
                title="Copy full public key"
                aria-label="Copy repeater public key"
              >
                {`${conversation.id.slice(0, 10)}…${conversation.id.slice(-6)}`}
              </button>
            </span>
          </span>
        </span>
        {contact && (
          <div className="col-span-2 row-start-2 min-w-0 text-[0.6875rem] text-muted-foreground min-[1100px]:col-span-1 min-[1100px]:col-start-2 min-[1100px]:row-start-1">
            <ContactStatusInfo contact={contact} ourLat={radioLat} ourLon={radioLon} />
          </div>
        )}
        <div className="flex items-center gap-0.5">
          {loggedIn && (
            <Button
              variant="outline"
              size="sm"
              onClick={loadAll}
              disabled={anyLoading}
              className="h-7 px-2 text-[0.6875rem] leading-none border-success text-success hover:bg-success/10 hover:text-success sm:h-8 sm:px-3 sm:text-xs"
            >
              {anyLoading ? 'Loading...' : 'Load All'}
            </Button>
          )}
          {contact && (
            <button
              className="p-1 rounded hover:bg-accent text-lg leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setPathDiscoveryOpen(true)}
              title="Path Discovery. Send a routed probe and inspect the forward and return paths"
              aria-label="Path Discovery"
            >
              <Route className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-accent text-lg leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onTrace}
            title="Direct Trace"
            aria-label="Direct Trace"
          >
            <DirectTraceIcon className="h-4 w-4 text-muted-foreground" />
          </button>
          {notificationsSupported && (
            <button
              className="flex items-center gap-1 rounded px-1 py-1 hover:bg-accent text-lg leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onToggleNotifications}
              title={
                notificationsEnabled
                  ? 'Disable desktop notifications for this conversation'
                  : notificationsPermission === 'denied'
                    ? 'Notifications blocked by the browser'
                    : 'Enable desktop notifications for this conversation'
              }
              aria-label={
                notificationsEnabled
                  ? 'Disable notifications for this conversation'
                  : 'Enable notifications for this conversation'
              }
            >
              <Bell
                className={`h-4 w-4 ${notificationsEnabled ? 'text-status-connected' : 'text-muted-foreground'}`}
                fill={notificationsEnabled ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
              {notificationsEnabled && (
                <span className="hidden md:inline text-[0.6875rem] font-medium text-status-connected">
                  Notifications On
                </span>
              )}
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-accent text-lg leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onToggleFavorite('contact', conversation.id)}
            title={
              isFav
                ? 'Remove from favorites. Favorite contacts stay loaded on the radio for ACK support.'
                : 'Add to favorites. Favorite contacts stay loaded on the radio for ACK support.'
            }
            aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
          >
            {isFav ? (
              <Star className="h-4 w-4 fill-current text-favorite" aria-hidden="true" />
            ) : (
              <Star className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
          <button
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive text-lg leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onDeleteContact(conversation.id)}
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {contact && (
          <ContactPathDiscoveryModal
            open={pathDiscoveryOpen}
            onClose={() => setPathDiscoveryOpen(false)}
            contact={contact}
            contacts={contacts}
            radioName={radioName}
            onDiscover={onPathDiscovery}
          />
        )}
      </header>
      <div data-toast-anchor="conversation" aria-hidden="true" />

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {!loggedIn ? (
          <RepeaterLogin
            repeaterName={conversation.name}
            loading={loginLoading}
            error={loginError}
            initialPassword={password}
            initialRememberPassword={rememberPassword}
            onLogin={handleRepeaterLogin}
            onLoginAsGuest={handleRepeaterGuestLogin}
          />
        ) : (
          <div className="space-y-4">
            <ServerLoginStatusBanner
              attempt={lastLoginAttempt}
              loading={loginLoading}
              canRetryPassword={password.length > 0}
              onRetryPassword={() => handleRepeaterLogin(password)}
              onRetryBlank={handleRepeaterGuestLogin}
              blankRetryLabel="Retry Existing-Access Login"
            />
            <section aria-label="Repeater details" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-sm">Repeater details</h3>
                <span className="text-xs text-muted-foreground">Fetch only what you need</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:items-start">
                <NodeInfoPane
                  data={paneData.nodeInfo}
                  state={paneStates.nodeInfo}
                  onRefresh={() => refreshPane('nodeInfo')}
                  disabled={anyLoading}
                />
                <TelemetryPane
                  data={paneData.status}
                  state={paneStates.status}
                  onRefresh={() => refreshPane('status')}
                  disabled={anyLoading}
                />
                <RadioSettingsPane
                  data={paneData.radioSettings}
                  state={paneStates.radioSettings}
                  onRefresh={() => refreshPane('radioSettings')}
                  disabled={anyLoading}
                  advertData={paneData.advertIntervals}
                  advertState={paneStates.advertIntervals}
                  onRefreshAdvert={() => refreshPane('advertIntervals')}
                />
                <LppTelemetryPane
                  data={paneData.lppTelemetry}
                  state={paneStates.lppTelemetry}
                  onRefresh={() => refreshPane('lppTelemetry')}
                  disabled={anyLoading}
                />
                <NeighborsPane
                  data={paneData.neighbors}
                  state={paneStates.neighbors}
                  onRefresh={() => refreshPane('neighbors')}
                  disabled={anyLoading}
                  repeaterContact={contact}
                  contacts={contacts}
                  nodeInfo={paneData.nodeInfo}
                  nodeInfoState={paneStates.nodeInfo}
                  repeaterName={conversation.name}
                />
                <AclPane
                  data={paneData.acl}
                  state={paneStates.acl}
                  onRefresh={() => refreshPane('acl')}
                  disabled={anyLoading}
                />
                <RegionsPane
                  data={paneData.regions}
                  state={paneStates.regions}
                  onRefresh={() => refreshPane('regions')}
                  disabled={anyLoading}
                />
                <OwnerInfoPane
                  data={paneData.ownerInfo}
                  state={paneStates.ownerInfo}
                  onRefresh={() => refreshPane('ownerInfo')}
                  disabled={anyLoading}
                />
              </div>
              <details className="border-t border-border pt-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced radio controls
                </summary>
                <div className="mt-3">
                  <ActionsPane
                    onSendZeroHopAdvert={sendZeroHopAdvert}
                    onSendFloodAdvert={sendFloodAdvert}
                    onSyncClock={syncClock}
                    onReboot={rebootRepeater}
                    consoleLoading={consoleLoading}
                  />
                </div>
              </details>
            </section>

            <details className="border-t border-border pt-2">
              <summary className="cursor-pointer text-sm font-medium">Command console</summary>
              <div className="mt-3">
                <ConsolePane
                  history={consoleHistory}
                  loading={consoleLoading}
                  onSend={sendConsoleCommand}
                />
              </div>
            </details>
            <TelemetryHistoryPane
              entries={telemetryHistory}
              loading={telemetryHistoryLoading}
              loadError={telemetryHistoryError}
              onRetry={loadTelemetryHistory}
              publicKey={conversation.id}
              contacts={contacts}
              trackedTelemetryRepeaters={trackedTelemetryRepeaters}
              onToggleTrackedTelemetry={onToggleTrackedTelemetry}
            />
          </div>
        )}
      </div>
    </div>
  );
}
