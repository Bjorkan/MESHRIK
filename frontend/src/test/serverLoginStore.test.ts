import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { api } from '../api';
import {
  resetServerLoginStoreForTests,
  serverLoginStore,
  startServerLogin,
} from '../stores/serverLoginStore';

vi.mock('../api', () => ({
  api: {
    repeaterLogin: vi.fn(),
    roomLogin: vi.fn(),
  },
}));

const mockApi = api as unknown as Record<string, Mock>;

describe('serverLoginStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetServerLoginStoreForTests();
  });

  it('fences a stale completion from a replacement generation', async () => {
    let resolveStale!: (value: { status: 'ok'; authenticated: true; message: null }) => void;
    let resolveCurrent!: (value: {
      status: 'timeout';
      authenticated: false;
      message: string;
    }) => void;
    mockApi.repeaterLogin
      .mockReturnValueOnce(new Promise((resolve) => (resolveStale = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveCurrent = resolve)));

    const stale = startServerLogin({
      kind: 'repeater',
      targetKey: 'AA',
      password: 'stale-secret',
      method: 'password',
    });
    resetServerLoginStoreForTests('repeater');
    const current = startServerLogin({
      kind: 'repeater',
      targetKey: 'AA',
      password: 'current-secret',
      method: 'password',
    });

    resolveStale({ status: 'ok', authenticated: true, message: null });
    await stale.promise;
    const pendingRecord = serverLoginStore.state.records['repeater:aa'];
    expect(pendingRecord?.phase).toBe('pending');
    expect(pendingRecord?.authenticated).toBe(false);

    resolveCurrent({ status: 'timeout', authenticated: false, message: 'No reply' });
    await current.promise;
    expect(serverLoginStore.state.records['repeater:aa']?.attempt?.outcome).toBe('not_confirmed');
    expect(JSON.stringify(serverLoginStore.state)).not.toContain('stale-secret');
    expect(JSON.stringify(serverLoginStore.state)).not.toContain('current-secret');
  });

  it('bounds retained terminal records', async () => {
    mockApi.repeaterLogin.mockResolvedValue({
      status: 'ok',
      authenticated: true,
      message: null,
    });

    for (let index = 0; index < 40; index += 1) {
      await startServerLogin({
        kind: 'repeater',
        targetKey: index.toString(16).padStart(2, '0'),
        password: '',
        method: 'blank',
      }).promise;
    }

    expect(Object.keys(serverLoginStore.state.records)).toHaveLength(32);
  });
});
