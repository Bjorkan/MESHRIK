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
      name: 'Command palette',
      description: 'Search conversations, tools, and settings',
      group: 'Global',
    },
  } satisfies AppHotkeyDefinition,
  messageSearch: {
    binding: '/',
    meta: {
      name: 'Message search',
      description: 'Open and focus message search',
      group: 'Navigation',
    },
  } satisfies AppHotkeyDefinition,
  shortcutHelp: {
    binding: '?',
    meta: {
      name: 'Keyboard shortcuts',
      description: 'Show the active shortcut registry',
      group: 'Global',
    },
  } satisfies AppHotkeyDefinition,
  map: {
    binding: ['G', 'M'],
    meta: {
      name: 'Node map',
      description: 'Navigate to the node map',
      group: 'Navigation',
    },
  } satisfies AppHotkeySequenceDefinition,
  radioActivity: {
    binding: ['G', 'R'],
    meta: {
      name: 'Radio activity',
      description: 'Navigate to radio activity',
      group: 'Navigation',
    },
  } satisfies AppHotkeySequenceDefinition,
} as const;
