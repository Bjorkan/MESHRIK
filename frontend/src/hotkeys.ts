import { t } from '@lingui/core/macro';
import type { Hotkey, HotkeyMeta, HotkeySequence } from '@tanstack/react-hotkeys';

interface AppHotkeyDefinition {
  binding: Hotkey;
  meta: HotkeyMeta;
}

interface AppHotkeySequenceDefinition {
  binding: HotkeySequence;
  meta: HotkeyMeta;
}

export const APP_HOTKEYS = {
  commandPalette: {
    binding: 'Mod+K',
    meta: {
      get name() {
        return t`Command palette`;
      },
      get description() {
        return t`Search conversations, tools, and settings`;
      },
      get group() {
        return t`Global`;
      },
    },
  } satisfies AppHotkeyDefinition,
  messageSearch: {
    binding: '/',
    meta: {
      get name() {
        return t`Message search`;
      },
      get description() {
        return t`Open and focus message search`;
      },
      get group() {
        return t`Navigation`;
      },
    },
  } satisfies AppHotkeyDefinition,
  shortcutHelp: {
    binding: '?',
    meta: {
      get name() {
        return t`Keyboard shortcuts`;
      },
      get description() {
        return t`Show the active shortcut registry`;
      },
      get group() {
        return t`Global`;
      },
    },
  } satisfies AppHotkeyDefinition,
  map: {
    binding: ['G', 'M'],
    meta: {
      get name() {
        return t`Node map`;
      },
      get description() {
        return t`Navigate to the node map`;
      },
      get group() {
        return t`Navigation`;
      },
    },
  } satisfies AppHotkeySequenceDefinition,
  radioActivity: {
    binding: ['G', 'R'],
    meta: {
      get name() {
        return t`Radio activity`;
      },
      get description() {
        return t`Navigate to radio activity`;
      },
      get group() {
        return t`Navigation`;
      },
    },
  } satisfies AppHotkeySequenceDefinition,
} as const;
