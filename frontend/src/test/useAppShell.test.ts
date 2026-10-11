import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAppShell } from '../hooks/useAppShell';

describe('useAppShell', () => {
  it('opens new-message modal and closes the sidebar', () => {
    const { result } = renderHook(() => useAppShell());

    act(() => {
      result.current.setSidebarOpen(true);
      result.current.handleOpenNewMessage();
    });

    expect(result.current.showNewMessage).toBe(true);
    expect(result.current.sidebarOpen).toBe(false);
  });

  it('toggles settings mode and closes the sidebar', () => {
    const { result } = renderHook(() => useAppShell());

    act(() => {
      result.current.setSidebarOpen(true);
      result.current.handleToggleSettingsView();
    });

    expect(result.current.showSettings).toBe(true);
    expect(result.current.sidebarOpen).toBe(false);

    act(() => {
      result.current.handleCloseSettingsView();
    });

    expect(result.current.showSettings).toBe(false);
  });

  it('initializes settings mode from the route section', () => {
    const { result } = renderHook(() => useAppShell({ routeSettingsSection: 'database' }));

    expect(result.current.showSettings).toBe(true);
    expect(result.current.settingsSection).toBe('database');
  });

  it('navigates when a settings section is selected', () => {
    const onNavigateSettings = vi.fn();
    const { result } = renderHook(() =>
      useAppShell({ routeSettingsSection: 'radio', onNavigateSettings })
    );

    act(() => {
      result.current.setSettingsSection('fanout');
    });

    expect(onNavigateSettings).toHaveBeenCalledWith('fanout');
  });

  it('opens the requested settings section through the router callback', () => {
    const onNavigateSettings = vi.fn();
    const { result } = renderHook(() =>
      useAppShell({ routeSettingsSection: null, onNavigateSettings })
    );

    act(() => {
      result.current.handleOpenSettingsSection('database');
    });

    expect(onNavigateSettings).toHaveBeenCalledWith('database');
    expect(result.current.sidebarOpen).toBe(false);
  });

  it('delegates settings close to the router', () => {
    const onCloseSettingsRoute = vi.fn();
    const { result } = renderHook(() =>
      useAppShell({ routeSettingsSection: 'radio', onCloseSettingsRoute })
    );

    act(() => {
      result.current.handleCloseSettingsView();
    });

    expect(onCloseSettingsRoute).toHaveBeenCalledOnce();
  });

  it('follows route changes into, across and out of settings', () => {
    const { result, rerender } = renderHook(
      ({ section }: { section: 'radio' | 'database' | null }) =>
        useAppShell({ routeSettingsSection: section }),
      { initialProps: { section: null as 'radio' | 'database' | null } }
    );

    expect(result.current.showSettings).toBe(false);

    act(() => {
      rerender({ section: 'radio' });
    });
    expect(result.current.showSettings).toBe(true);
    expect(result.current.settingsSection).toBe('radio');

    act(() => {
      rerender({ section: 'database' });
    });
    expect(result.current.settingsSection).toBe('database');

    act(() => {
      rerender({ section: null });
    });
    expect(result.current.showSettings).toBe(false);
  });

  it('toggles the cracker shell without affecting sidebar state', () => {
    const { result } = renderHook(() => useAppShell());

    act(() => {
      result.current.setSidebarOpen(true);
      result.current.handleToggleCracker();
    });

    expect(result.current.showCracker).toBe(true);
    expect(result.current.sidebarOpen).toBe(true);
  });
});
