import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';

import { api } from '../api';
import type { RepeaterLoginResponse } from '../types';
import {
  buildServerLoginAttemptFromError,
  buildServerLoginAttemptFromResponse,
  type ServerLoginAttemptState,
  type ServerLoginMethod,
} from '../utils/serverLoginState';

export type ServerLoginKind = 'repeater' | 'room';
export type ServerLoginPhase = 'pending' | 'terminal';

export interface ServerLoginRecord {
  kind: ServerLoginKind;
  targetKey: string;
  attemptId: string;
  generation: number;
  method: ServerLoginMethod;
  phase: ServerLoginPhase;
  authenticated: boolean;
  accessGranted: boolean;
  attempt: ServerLoginAttemptState | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface ServerLoginStoreState {
  records: Record<string, ServerLoginRecord>;
}

interface LoginLifecycle {
  onStarted?: () => void;
  onConfirmed?: () => void;
  onSettled?: (record: ServerLoginRecord) => void;
}

interface StartServerLoginOptions extends LoginLifecycle {
  kind: ServerLoginKind;
  targetKey: string;
  password: string;
  method: ServerLoginMethod;
}

export interface StartedServerLogin {
  started: boolean;
  promise: Promise<boolean>;
}

const MAX_TERMINAL_RECORDS = 32;
let nextAttemptId = 1;

export const serverLoginStore = new Store<ServerLoginStoreState>({ records: {} });

const inFlightPromises = new Map<string, Promise<boolean>>();

function normalizeTargetKey(targetKey: string): string {
  return targetKey.trim().toLowerCase();
}

function getRecordKey(kind: ServerLoginKind, targetKey: string): string {
  return `${kind}:${normalizeTargetKey(targetKey)}`;
}

function pruneTerminalRecords(
  records: Record<string, ServerLoginRecord>
): Record<string, ServerLoginRecord> {
  const terminalEntries = Object.entries(records).filter(
    ([, record]) => record.phase === 'terminal'
  );
  if (terminalEntries.length <= MAX_TERMINAL_RECORDS) return records;

  const removeCount = terminalEntries.length - MAX_TERMINAL_RECORDS;
  const keysToRemove = new Set(
    terminalEntries
      .sort(([, left], [, right]) => (left.completedAt ?? 0) - (right.completedAt ?? 0))
      .slice(0, removeCount)
      .map(([key]) => key)
  );
  return Object.fromEntries(Object.entries(records).filter(([key]) => !keysToRemove.has(key)));
}

function commitTerminalRecord(recordKey: string, record: ServerLoginRecord): boolean {
  let committed = false;
  serverLoginStore.setState((state) => {
    const current = state.records[recordKey];
    if (
      !current ||
      current.attemptId !== record.attemptId ||
      current.generation !== record.generation
    ) {
      return state;
    }
    committed = true;
    return { records: pruneTerminalRecords({ ...state.records, [recordKey]: record }) };
  });
  return committed;
}

function requestLogin(
  kind: ServerLoginKind,
  targetKey: string,
  password: string
): Promise<RepeaterLoginResponse> {
  return kind === 'repeater'
    ? api.repeaterLogin(targetKey, password)
    : api.roomLogin(targetKey, password);
}

function entityLabel(kind: ServerLoginKind): string {
  return kind === 'repeater' ? 'repeater' : 'room server';
}

function runLifecycleCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // UI-side persistence/notification failures must not change the RF outcome.
  }
}

function runSettledCallback(
  callback: ((record: ServerLoginRecord) => void) | undefined,
  record: ServerLoginRecord
): void {
  try {
    callback?.(record);
  } catch {
    // The terminal store record remains authoritative if a UI callback fails.
  }
}

/**
 * Starts one app-lifetime login operation per server, or joins the existing one.
 * The submitted password stays only in this request closure and is never stored.
 */
export function startServerLogin(options: StartServerLoginOptions): StartedServerLogin {
  const targetKey = normalizeTargetKey(options.targetKey);
  const recordKey = getRecordKey(options.kind, targetKey);
  const existing = inFlightPromises.get(recordKey);
  if (existing) return { started: false, promise: existing };

  const previous = serverLoginStore.state.records[recordKey];
  const generation = (previous?.generation ?? 0) + 1;
  const pending: ServerLoginRecord = {
    kind: options.kind,
    targetKey,
    attemptId: `${Date.now()}-${nextAttemptId++}`,
    generation,
    method: options.method,
    phase: 'pending',
    authenticated: false,
    accessGranted: previous?.accessGranted ?? false,
    attempt: previous?.attempt ?? null,
    error: null,
    startedAt: Date.now(),
    completedAt: null,
  };

  // Publish pending synchronously before invoking any callbacks or API code. This
  // closes double-click and password-vs-guest races in the same event turn.
  serverLoginStore.setState((state) => ({
    records: { ...state.records, [recordKey]: pending },
  }));

  let resolveRequest!: (result: RepeaterLoginResponse) => void;
  let rejectRequest!: (error: unknown) => void;
  const request = new Promise<RepeaterLoginResponse>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const promise = request
    .then((result) => {
      const attempt = buildServerLoginAttemptFromResponse(
        options.method,
        result,
        entityLabel(options.kind)
      );
      const terminal: ServerLoginRecord = {
        ...pending,
        phase: 'terminal',
        authenticated: result.authenticated,
        accessGranted: true,
        attempt,
        error: result.authenticated
          ? null
          : (result.message ?? `${entityLabel(options.kind)} login was not confirmed`),
        completedAt: Date.now(),
      };
      if (commitTerminalRecord(recordKey, terminal)) {
        if (result.authenticated) runLifecycleCallback(options.onConfirmed);
        runSettledCallback(options.onSettled, terminal);
      }
      return result.authenticated;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Login failed';
      const terminal: ServerLoginRecord = {
        ...pending,
        phase: 'terminal',
        authenticated: false,
        accessGranted: true,
        attempt: buildServerLoginAttemptFromError(
          options.method,
          message,
          entityLabel(options.kind)
        ),
        error: message,
        completedAt: Date.now(),
      };
      if (commitTerminalRecord(recordKey, terminal)) {
        runSettledCallback(options.onSettled, terminal);
      }
      return false;
    })
    .finally(() => {
      if (inFlightPromises.get(recordKey) === promise) inFlightPromises.delete(recordKey);
    });

  // Register the shared promise before user callbacks or API code can re-enter.
  inFlightPromises.set(recordKey, promise);
  runLifecycleCallback(options.onStarted);
  try {
    void requestLogin(options.kind, targetKey, options.password).then(
      resolveRequest,
      rejectRequest
    );
  } catch (error) {
    rejectRequest(error);
  }
  return { started: true, promise };
}

export function useServerLogin(
  kind: ServerLoginKind,
  targetKey: string | null
): ServerLoginRecord | null {
  const recordKey = targetKey ? getRecordKey(kind, targetKey) : null;
  return useStore(serverLoginStore, (state) =>
    recordKey ? (state.records[recordKey] ?? null) : null
  );
}

export function resetServerLoginStoreForTests(kind?: ServerLoginKind): void {
  if (!kind) {
    inFlightPromises.clear();
    serverLoginStore.setState(() => ({ records: {} }));
    nextAttemptId = 1;
    return;
  }

  const prefix = `${kind}:`;
  for (const key of inFlightPromises.keys()) {
    if (key.startsWith(prefix)) inFlightPromises.delete(key);
  }
  serverLoginStore.setState((state) => ({
    records: Object.fromEntries(
      Object.entries(state.records).filter(([key]) => !key.startsWith(prefix))
    ),
  }));
}
