import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRememberedServerPassword } from '../hooks/useRememberedServerPassword';

describe('useRememberedServerPassword', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores the last in-memory password when local remember is disabled', () => {
    const { result, unmount } = renderHook(() =>
      useRememberedServerPassword('room', 'aa'.repeat(32))
    );

    act(() => {
      result.current.recordLoginAttempt('room-secret', false);
    });

    expect(result.current.password).toBe('room-secret');
    unmount();

    const { result: remounted } = renderHook(() =>
      useRememberedServerPassword('room', 'aa'.repeat(32))
    );

    expect(remounted.current.password).toBe('room-secret');
    expect(remounted.current.rememberPassword).toBe(false);
  });

  it('keeps a failed retry ephemeral without replacing a confirmed password', () => {
    const publicKey = 'bb'.repeat(32);
    const storageKey = `meshrik-server-password:room:${publicKey}`;
    localStorage.setItem(storageKey, JSON.stringify({ password: 'confirmed-secret' }));
    const { result } = renderHook(() => useRememberedServerPassword('room', publicKey));

    act(() => result.current.recordLoginAttempt('failed-new-secret', true));

    expect(result.current.password).toBe('failed-new-secret');
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ password: 'confirmed-secret' }));
  });

  it('persists every character only after a confirmed login', () => {
    const publicKey = 'cc'.repeat(32);
    const storageKey = `meshrik-server-password:repeater:${publicKey}`;
    const { result } = renderHook(() => useRememberedServerPassword('repeater', publicKey));

    act(() => result.current.persistConfirmedPassword('  exact secret  ', true));

    expect(result.current.password).toBe('  exact secret  ');
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify({ password: '  exact secret  ' }));
  });

  it('removes durable credentials after a confirmed login with remember disabled', () => {
    const publicKey = 'dd'.repeat(32);
    const storageKey = `meshrik-server-password:room:${publicKey}`;
    localStorage.setItem(storageKey, JSON.stringify({ password: 'old-secret' }));
    const { result } = renderHook(() => useRememberedServerPassword('room', publicKey));

    act(() => result.current.persistConfirmedPassword('new-session-secret', false));

    expect(result.current.password).toBe('new-session-secret');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
