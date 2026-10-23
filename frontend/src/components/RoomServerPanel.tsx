import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api';
import { toast } from './ui/sonner';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import type {
  Contact,
  PaneState,
  RepeaterAclResponse,
  RepeaterLppTelemetryResponse,
  RepeaterStatusResponse,
} from '../types';
import { TelemetryPane } from './repeater/RepeaterTelemetryPane';
import { AclPane } from './repeater/RepeaterAclPane';
import { LppTelemetryPane } from './repeater/RepeaterLppTelemetryPane';
import { ConsolePane } from './repeater/RepeaterConsolePane';
import { RepeaterLogin } from './RepeaterLogin';
import { ServerLoginStatusBanner } from './ServerLoginStatusBanner';
import { useRememberedServerPassword } from '../hooks/useRememberedServerPassword';
import type { ServerLoginAttemptState, ServerLoginMethod } from '../utils/serverLoginState';
import {
  resetServerLoginStoreForTests,
  startServerLogin,
  useServerLogin,
} from '../stores/serverLoginStore';

interface RoomServerPanelProps {
  contact: Contact;
  onAuthenticatedChange?: (authenticated: boolean) => void;
}

type RoomPaneKey = 'status' | 'acl' | 'lppTelemetry';

type RoomPaneData = {
  status: RepeaterStatusResponse | null;
  acl: RepeaterAclResponse | null;
  lppTelemetry: RepeaterLppTelemetryResponse | null;
};

type RoomPaneStates = Record<RoomPaneKey, PaneState>;

type ConsoleEntry = {
  command: string;
  response: string;
  timestamp: number;
  outgoing: boolean;
};

const INITIAL_PANE_STATE: PaneState = {
  loading: false,
  attempt: 0,
  error: null,
  fetched_at: null,
};

function createInitialPaneStates(): RoomPaneStates {
  return {
    status: { ...INITIAL_PANE_STATE },
    acl: { ...INITIAL_PANE_STATE },
    lppTelemetry: { ...INITIAL_PANE_STATE },
  };
}

function createInitialPaneData(): RoomPaneData {
  return { status: null, acl: null, lppTelemetry: null };
}

// ---------------------------------------------------------------------------
// In-memory LRU cache so room login state survives conversation switches
// ---------------------------------------------------------------------------

interface RoomCacheEntry {
  authenticated: boolean;
  loginError: string | null;
  lastLoginAttempt: ServerLoginAttemptState | null;
  paneData: RoomPaneData;
  paneStates: RoomPaneStates;
  consoleHistory: ConsoleEntry[];
}

const MAX_CACHED_ROOMS = 8;
const roomCache = new Map<string, RoomCacheEntry>();

function getCachedRoom(publicKey: string): RoomCacheEntry | null {
  const cached = roomCache.get(publicKey);
  if (!cached) return null;
  // Touch for LRU
  roomCache.delete(publicKey);
  roomCache.set(publicKey, cached);
  return {
    ...cached,
    paneData: { ...cached.paneData },
    paneStates: {
      status: { ...cached.paneStates.status, loading: false },
      acl: { ...cached.paneStates.acl, loading: false },
      lppTelemetry: { ...cached.paneStates.lppTelemetry, loading: false },
    },
    consoleHistory: cached.consoleHistory.map((e) => ({ ...e })),
  };
}

function setCachedRoom(publicKey: string, entry: RoomCacheEntry) {
  roomCache.delete(publicKey);
  roomCache.set(publicKey, {
    ...entry,
    paneData: { ...entry.paneData },
    paneStates: {
      status: { ...entry.paneStates.status, loading: false },
      acl: { ...entry.paneStates.acl, loading: false },
      lppTelemetry: { ...entry.paneStates.lppTelemetry, loading: false },
    },
    consoleHistory: entry.consoleHistory.map((e) => ({ ...e })),
  });
  if (roomCache.size > MAX_CACHED_ROOMS) {
    const lruKey = roomCache.keys().next().value as string | undefined;
    if (lruKey) roomCache.delete(lruKey);
  }
}

export function resetRoomCacheForTests() {
  roomCache.clear();
  resetServerLoginStoreForTests('room');
}

export function RoomServerPanel({ contact, onAuthenticatedChange }: RoomServerPanelProps) {
  useLingui();

  const { password, rememberPassword, recordLoginAttempt, persistConfirmedPassword } =
    useRememberedServerPassword('room', contact.public_key);

  const cached = useMemo(() => getCachedRoom(contact.public_key), [contact.public_key]);
  const loginRecord = useServerLogin('room', contact.public_key);

  const loginLoading = loginRecord?.phase === 'pending';
  const loginError = loginRecord ? loginRecord.error : (cached?.loginError ?? null);
  const authenticated = loginRecord?.accessGranted ?? cached?.authenticated ?? false;
  const lastLoginAttempt = loginRecord ? loginRecord.attempt : (cached?.lastLoginAttempt ?? null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [paneData, setPaneData] = useState<RoomPaneData>(cached?.paneData ?? createInitialPaneData);
  const [paneStates, setPaneStates] = useState<RoomPaneStates>(
    cached?.paneStates ?? createInitialPaneStates
  );
  const [consoleHistory, setConsoleHistory] = useState<ConsoleEntry[]>(
    cached?.consoleHistory ?? []
  );
  const [consoleLoading, setConsoleLoading] = useState(false);

  // Persist to cache on every state change
  useEffect(() => {
    setCachedRoom(contact.public_key, {
      authenticated,
      loginError,
      lastLoginAttempt,
      paneData,
      paneStates,
      consoleHistory,
    });
  }, [
    contact.public_key,
    authenticated,
    loginError,
    lastLoginAttempt,
    paneData,
    paneStates,
    consoleHistory,
  ]);

  useEffect(() => {
    onAuthenticatedChange?.(authenticated);
  }, [authenticated, onAuthenticatedChange]);

  const refreshPane = useCallback(
    async <K extends RoomPaneKey>(pane: K, loader: () => Promise<RoomPaneData[K]>) => {
      setPaneStates((prev) => ({
        ...prev,
        [pane]: {
          ...prev[pane],
          loading: true,
          attempt: prev[pane].attempt + 1,
          error: null,
        },
      }));

      try {
        const data = await loader();
        setPaneData((prev) => ({ ...prev, [pane]: data }));
        setPaneStates((prev) => ({
          ...prev,
          [pane]: {
            loading: false,
            attempt: prev[pane].attempt,
            error: null,
            fetched_at: Date.now(),
          },
        }));
      } catch (err) {
        setPaneStates((prev) => ({
          ...prev,
          [pane]: {
            ...prev[pane],
            loading: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          },
        }));
      }
    },
    []
  );

  const performLogin = useCallback(
    (
      nextPassword: string,
      method: ServerLoginMethod,
      lifecycle: { onStarted?: () => void; onConfirmed?: () => void } = {}
    ) => {
      return startServerLogin({
        kind: 'room',
        targetKey: contact.public_key,
        password: nextPassword,
        method,
        onStarted: lifecycle.onStarted,
        onConfirmed: lifecycle.onConfirmed,
        onSettled: (record) => {
          if (record.authenticated) {
            toast.success(t`Login confirmed by the room server.`);
          } else if (record.attempt?.outcome === 'not_confirmed') {
            toast.warning(t`Couldn't confirm room login`, {
              description:
                record.error ??
                'No confirmation came back from the room server. You can still open tools and try again.',
            });
          } else {
            toast.error(t`Room login request failed`, {
              get description() {
                return t`${record.error ?? 'Unknown error'}. You can still open tools and retry the login from here.`;
              },
            });
          }
        },
      }).promise;
    },
    [contact.public_key]
  );

  const handleLogin = useCallback(
    async (nextPassword: string, shouldRemember = rememberPassword) => {
      await performLogin(nextPassword, 'password', {
        onStarted: () => recordLoginAttempt(nextPassword, shouldRemember),
        onConfirmed: () => persistConfirmedPassword(nextPassword, shouldRemember),
      });
    },
    [performLogin, persistConfirmedPassword, recordLoginAttempt, rememberPassword]
  );

  const handleLoginAsGuest = useCallback(async () => {
    await performLogin('', 'blank');
  }, [performLogin]);

  const handleConsoleCommand = useCallback(
    async (command: string) => {
      setConsoleLoading(true);
      const timestamp = Date.now();
      setConsoleHistory((prev) => [
        ...prev,
        { command, response: command, timestamp, outgoing: true },
      ]);
      try {
        const response = await api.sendRepeaterCommand(contact.public_key, command);
        setConsoleHistory((prev) => [
          ...prev,
          {
            command,
            response: response.response,
            timestamp: Date.now(),
            outgoing: false,
          },
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setConsoleHistory((prev) => [
          ...prev,
          {
            command,
            response: `(error) ${message}`,
            timestamp: Date.now(),
            outgoing: false,
          },
        ]);
      } finally {
        setConsoleLoading(false);
      }
    },
    [contact.public_key]
  );

  const panelTitle = useMemo(() => contact.name || contact.public_key.slice(0, 12), [contact]);
  const showLoginFailureState =
    lastLoginAttempt !== null && lastLoginAttempt.outcome !== 'confirmed';

  if (!authenticated) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
          <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <Trans>
              Room server access is experimental and in public alpha. Please report any issues on{' '}
              <a
                href="https://github.com/Bjorkan/MESHRIK/issues"
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-2 hover:text-warning/80"
              >
                GitHub
              </a>
              .
            </Trans>
          </div>
          <RepeaterLogin
            repeaterName={panelTitle}
            loading={loginLoading}
            error={loginError}
            initialPassword={password}
            initialRememberPassword={rememberPassword}
            onLogin={handleLogin}
            onLoginAsGuest={handleLoginAsGuest}
            description={t`Log in with the room password or use ACL/guest access to enter this room server`}
            passwordPlaceholder="Room server password..."
            guestLabel="Login with Existing Access / Guest"
          />
        </div>
      </div>
    );
  }

  return (
    <section className="border-b border-border bg-muted/20 px-4 py-3">
      <div className="space-y-3">
        {showLoginFailureState ? (
          <ServerLoginStatusBanner
            attempt={lastLoginAttempt}
            loading={loginLoading}
            canRetryPassword={password.length > 0}
            onRetryPassword={() => handleLogin(password)}
            onRetryBlank={handleLoginAsGuest}
            blankRetryLabel="Retry Existing-Access Login"
            showRetryActions={false}
          />
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {showLoginFailureState ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleLogin(password)}
                disabled={loginLoading || password.length === 0}
              >
                <Trans>Retry Password Login</Trans>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLoginAsGuest}
                disabled={loginLoading}
              >
                <Trans>Retry Existing-Access Login</Trans>
              </Button>
            </div>
          ) : (
            <div />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdvancedOpen((prev) => !prev)}
          >
            {advancedOpen ? t`Hide Tools` : t`Show Tools`}
          </Button>
        </div>
      </div>
      <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <SheetContent side="right" className="w-full sm:max-w-4xl p-0 flex flex-col">
          <SheetHeader className="sr-only">
            <SheetTitle>
              <Trans>Room Server Tools</Trans>
            </SheetTitle>
            <SheetDescription>
              <Trans>Room server telemetry, ACL tools, sensor data, and CLI console</Trans>
            </SheetDescription>
          </SheetHeader>
          <div className="border-b border-border px-4 py-3 pr-14">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">
                  <Trans>Room Server Tools</Trans>
                </h2>
                <p className="text-sm text-muted-foreground">{panelTitle}</p>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid gap-3 xl:grid-cols-2">
              <TelemetryPane
                data={paneData.status}
                state={paneStates.status}
                onRefresh={() => refreshPane('status', () => api.roomStatus(contact.public_key))}
              />
              <AclPane
                data={paneData.acl}
                state={paneStates.acl}
                onRefresh={() => refreshPane('acl', () => api.roomAcl(contact.public_key))}
              />
              <LppTelemetryPane
                data={paneData.lppTelemetry}
                state={paneStates.lppTelemetry}
                onRefresh={() =>
                  refreshPane('lppTelemetry', () => api.roomLppTelemetry(contact.public_key))
                }
              />
              <ConsolePane
                history={consoleHistory}
                loading={consoleLoading}
                onSend={handleConsoleCommand}
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
