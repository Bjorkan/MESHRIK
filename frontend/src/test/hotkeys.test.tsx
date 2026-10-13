import { StrictMode, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider, matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import { describe, expect, it, vi } from 'vitest';

import { CommandPalette } from '../components/CommandPalette';
import { ShortcutHelpDialog } from '../components/ShortcutHelpDialog';
import { APP_HOTKEYS } from '../hotkeys';
import { useAppHotkeys } from '../hooks/useAppHotkeys';

interface HarnessProps {
  commandPaletteEnabled?: boolean;
  navigationEnabled?: boolean;
  shortcutHelpEnabled?: boolean;
  onPalette?: () => void;
  onHelp?: () => void;
  onSearch?: () => void;
  onMap?: () => void;
  onRadioActivity?: () => void;
}

function HotkeyHarness({
  commandPaletteEnabled = true,
  navigationEnabled = true,
  shortcutHelpEnabled = true,
  onPalette = () => undefined,
  onHelp = () => undefined,
  onSearch = () => undefined,
  onMap = () => undefined,
  onRadioActivity = () => undefined,
}: HarnessProps) {
  useAppHotkeys({
    commandPaletteEnabled,
    navigationEnabled,
    shortcutHelpEnabled,
    onToggleCommandPalette: onPalette,
    onOpenShortcutHelp: onHelp,
    onOpenMessageSearch: onSearch,
    onOpenMap: onMap,
    onOpenRadioActivity: onRadioActivity,
  });
  return <input aria-label="Editor" />;
}

function renderHarness(props: HarnessProps = {}) {
  return render(
    <HotkeysProvider
      defaultOptions={{
        hotkey: { conflictBehavior: 'error' },
        hotkeySequence: { conflictBehavior: 'error' },
      }}
    >
      <HotkeyHarness {...props} />
    </HotkeysProvider>
  );
}

describe('application hotkeys', () => {
  it('uses Mod for Windows Control and macOS Command conventions', () => {
    const windowsEvent = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
    });
    const macEvent = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
    });

    expect(matchesKeyboardEvent(windowsEvent, APP_HOTKEYS.commandPalette.binding, 'windows')).toBe(
      true
    );
    expect(matchesKeyboardEvent(macEvent, APP_HOTKEYS.commandPalette.binding, 'mac')).toBe(true);
  });

  it('allows Mod+K in inputs but protects single-key navigation while typing', () => {
    const onPalette = vi.fn();
    const onSearch = vi.fn();
    renderHarness({ onPalette, onSearch });
    const input = screen.getByRole('textbox', { name: 'Editor' });

    fireEvent.keyDown(input, { key: '/', code: 'Slash' });
    fireEvent.keyDown(input, { key: 'k', code: 'KeyK', ctrlKey: true });

    expect(onSearch).not.toHaveBeenCalled();
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated keydown and respects disabled registrations', () => {
    const onPalette = vi.fn();
    const { rerender } = renderHarness({ onPalette });

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true, repeat: true });
    expect(onPalette).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(document, { key: 'k', code: 'KeyK', ctrlKey: true });

    rerender(
      <HotkeysProvider>
        <HotkeyHarness commandPaletteEnabled={false} onPalette={onPalette} />
      </HotkeysProvider>
    );
    fireEvent.keyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it('dispatches compound navigation sequences and unregisters under StrictMode', () => {
    const onMap = vi.fn();
    const onRadioActivity = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <HotkeysProvider>
          <HotkeyHarness onMap={onMap} onRadioActivity={onRadioActivity} />
        </HotkeysProvider>
      </StrictMode>
    );

    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 'm', code: 'KeyM' });
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 'r', code: 'KeyR' });
    expect(onMap).toHaveBeenCalledTimes(1);
    expect(onRadioActivity).toHaveBeenCalledTimes(1);

    unmount();
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document, { key: 'm', code: 'KeyM' });
    expect(onMap).toHaveBeenCalledTimes(1);
  });

  it('builds shortcut help from live metadata registrations', async () => {
    render(
      <HotkeysProvider>
        <HotkeyHarness />
        <ShortcutHelpDialog open onOpenChange={vi.fn()} />
      </HotkeysProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Command palette')).toBeVisible());
    expect(screen.getByText('Message search')).toBeVisible();
    expect(screen.getByText('Node map')).toBeVisible();
    expect(screen.getByText('Radio activity')).toBeVisible();
  });

  it('lets the accessible dialog primitive own Escape closing', async () => {
    const onOpenChange = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    function OpenPalette() {
      const [open, setOpen] = useState(true);
      return (
        <CommandPalette
          open={open}
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
          contacts={[]}
          channels={[]}
          onSelectConversation={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenShortcutHelp={vi.fn()}
          onRepeaterAutoLogin={vi.fn()}
        />
      );
    }

    render(<OpenPalette />);
    expect(await screen.findByRole('heading', { name: 'Command palette' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
