import { useHotkey } from '@tanstack/react-hotkeys';

import { APP_HOTKEYS } from '../hotkeys';

interface UseAppHotkeysArgs {
  commandPaletteEnabled: boolean;
  navigationEnabled: boolean;
  shortcutHelpEnabled: boolean;
  onToggleCommandPalette: () => void;
  onOpenShortcutHelp: () => void;
  onOpenMessageSearch: () => void;
  onOpenMap: () => void;
  onOpenRadioActivity: () => void;
}

export function useAppHotkeys({
  commandPaletteEnabled,
  navigationEnabled,
  shortcutHelpEnabled,
  onToggleCommandPalette,
  onOpenShortcutHelp,
  onOpenMessageSearch,
  onOpenMap,
  onOpenRadioActivity,
}: UseAppHotkeysArgs): void {
  useHotkey(APP_HOTKEYS.commandPalette.binding, onToggleCommandPalette, {
    enabled: commandPaletteEnabled,
    ignoreInputs: false,
    meta: APP_HOTKEYS.commandPalette.meta,
    requireReset: true,
  });
  useHotkey(APP_HOTKEYS.messageSearch.binding, onOpenMessageSearch, {
    enabled: navigationEnabled,
    ignoreInputs: true,
    meta: APP_HOTKEYS.messageSearch.meta,
    requireReset: true,
  });
  useHotkey(APP_HOTKEYS.shortcutHelp.binding, onOpenShortcutHelp, {
    enabled: shortcutHelpEnabled,
    ignoreInputs: true,
    meta: APP_HOTKEYS.shortcutHelp.meta,
    requireReset: true,
  });
  useHotkey(APP_HOTKEYS.map.binding, onOpenMap, {
    enabled: navigationEnabled,
    ignoreInputs: true,
    meta: APP_HOTKEYS.map.meta,
  });
  useHotkey(APP_HOTKEYS.radioActivity.binding, onOpenRadioActivity, {
    enabled: navigationEnabled,
    ignoreInputs: true,
    meta: APP_HOTKEYS.radioActivity.meta,
  });
}
