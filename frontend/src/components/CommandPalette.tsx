import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useMemo, useState } from 'react';
import { formatForDisplay } from '@tanstack/react-hotkeys';
import {
  Hash,
  Map,
  MessageSquare,
  Network,
  Radio,
  Route,
  Search,
  Star,
  User,
  Waypoints,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { getContactDisplayName } from '../utils/pubkey';
import {
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTION_ICONS,
  type SettingsSection,
} from './settings/settingsConstants';
import type { Channel, Contact, Conversation } from '../types';
import { CONTACT_TYPE_REPEATER, CONTACT_TYPE_ROOM } from '../types';
import { APP_HOTKEYS } from '../hotkeys';

const MAX_PER_GROUP = 8;

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: Contact[];
  channels: Channel[];
  onSelectConversation: (conv: Conversation) => void;
  onOpenSettings: (section: SettingsSection) => void;
  onOpenShortcutHelp: () => void;
  onRepeaterAutoLogin: (publicKey: string, displayName: string) => void;
}

interface Searchable {
  searchText: string;
  keyText?: string;
}

interface SearchableContact extends Searchable {
  contact: Contact;
  displayName: string;
}

interface SearchableChannel extends Searchable {
  channel: Channel;
}

interface ToolItem extends Searchable {
  id: string;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  type: 'raw' | 'map' | 'visualizer' | 'search' | 'trace';
}

interface SettingItem extends Searchable {
  section: SettingsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function getToolItems(): ToolItem[] {
  const definitions = [
    { id: 'raw', name: t`Raw Packet Feed`, icon: Radio, type: 'raw', aliases: 'raw packet feed' },
    { id: 'map', name: t`Map View`, icon: Map, type: 'map', aliases: 'map view' },
    {
      id: 'visualizer',
      name: t`Network Visualizer`,
      icon: Network,
      type: 'visualizer',
      aliases: 'network visualizer',
    },
    {
      id: 'search',
      name: t`Message Search`,
      icon: Search,
      type: 'search',
      aliases: 'message search',
    },
    { id: 'trace', name: t`Route Trace`, icon: Route, type: 'trace', aliases: 'route trace' },
  ] as const;
  return definitions.map(({ aliases, ...item }) => ({
    ...item,
    searchText: `${item.name} ${aliases}`.toLowerCase(),
  }));
}

function getSettingItems(): SettingItem[] {
  return SETTINGS_SECTION_ORDER.map((section) => ({
    section,
    label: SETTINGS_SECTION_LABELS[section],
    icon: SETTINGS_SECTION_ICONS[section],
    searchText: `${t`Settings`} ${SETTINGS_SECTION_LABELS[section]} settings`.toLowerCase(),
  }));
}

function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

function filterList<T extends Searchable>(items: T[], query: string): T[] {
  if (!query) return items.slice(0, MAX_PER_GROUP);
  const results: T[] = [];
  for (const item of items) {
    const nameMatch = fuzzyMatch(item.searchText, query);
    const keyMatch = item.keyText ? item.keyText.startsWith(query) : false;
    if (nameMatch || keyMatch) {
      results.push(item);
      if (results.length >= MAX_PER_GROUP) break;
    }
  }
  return results;
}

export function CommandPalette({
  open,
  onOpenChange,
  contacts,
  channels,
  onSelectConversation,
  onOpenSettings,
  onOpenShortcutHelp,
  onRepeaterAutoLogin,
}: CommandPaletteProps) {
  useLingui();

  const [query, setQuery] = useState('');

  const select = useCallback(
    (action: () => void) => {
      onOpenChange(false);
      action();
    },
    [onOpenChange]
  );

  const {
    favContacts,
    favRepeaters,
    regularContacts,
    repeaters,
    rooms,
    favChannels,
    regularChannels,
  } = useMemo(() => {
    const fc: SearchableContact[] = [];
    const fr: SearchableContact[] = [];
    const rc: SearchableContact[] = [];
    const rp: SearchableContact[] = [];
    const rm: SearchableContact[] = [];
    for (const c of contacts) {
      const displayName = getContactDisplayName(c.name, c.public_key, c.last_advert);
      const entry: SearchableContact = {
        contact: c,
        displayName,
        searchText: displayName.toLowerCase(),
        keyText: c.public_key.toLowerCase(),
      };
      if (c.type === CONTACT_TYPE_REPEATER) {
        (c.favorite ? fr : rp).push(entry);
      } else if (c.type === CONTACT_TYPE_ROOM) {
        rm.push(entry);
      } else {
        (c.favorite ? fc : rc).push(entry);
      }
    }
    const fch: SearchableChannel[] = [];
    const rch: SearchableChannel[] = [];
    for (const ch of channels) {
      const entry: SearchableChannel = {
        channel: ch,
        searchText: ch.name.toLowerCase(),
        keyText: ch.key.toLowerCase(),
      };
      (ch.favorite ? fch : rch).push(entry);
    }
    return {
      favContacts: fc,
      favRepeaters: fr,
      regularContacts: rc,
      repeaters: rp,
      rooms: rm,
      favChannels: fch,
      regularChannels: rch,
    };
  }, [contacts, channels]);

  const lq = query.toLowerCase();
  const fTools = filterList(getToolItems(), lq);
  const fSettings = filterList(getSettingItems(), lq);
  const fFavContacts = filterList(favContacts, lq);
  const fFavRepeaters = filterList(favRepeaters, lq);
  const fFavChannels = filterList(favChannels, lq);
  const fContacts = filterList(regularContacts, lq);
  const fRepeaters = filterList(repeaters, lq);
  const fRooms = filterList(rooms, lq);
  const fChannels = filterList(regularChannels, lq);

  const totalResults =
    fTools.length +
    fSettings.length +
    fFavContacts.length +
    fFavRepeaters.length +
    fFavChannels.length +
    fContacts.length +
    fRepeaters.length +
    fRooms.length +
    fChannels.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <DialogContent className="overflow-hidden p-0 shadow-lg" hideCloseButton>
        <DialogTitle className="sr-only">
          <Trans>Command palette</Trans>
        </DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Search for conversations, settings, and tools</Trans>
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput placeholder={t`Jump to...`} value={query} onValueChange={setQuery} />
          <CommandList>
            {totalResults === 0 && (
              <CommandEmpty>
                <Trans>No results found.</Trans>
              </CommandEmpty>
            )}

            {fTools.length > 0 && (
              <CommandGroup heading={t`Tools`}>
                {fTools.map((tool) => (
                  <CommandItem
                    key={tool.id}
                    onSelect={() =>
                      select(() =>
                        onSelectConversation({ type: tool.type, id: tool.id, name: tool.name })
                      )
                    }
                  >
                    <tool.icon className="text-muted-foreground" />
                    <span>{tool.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {fSettings.length > 0 && (
              <CommandGroup heading={t`Settings`}>
                {fSettings.map((item) => (
                  <CommandItem
                    key={item.section}
                    onSelect={() => select(() => onOpenSettings(item.section))}
                  >
                    <item.icon className="text-muted-foreground" />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {fFavContacts.length > 0 && (
              <ContactGroup
                heading={t`Favorite Contacts`}
                items={fFavContacts}
                icon={User}
                onSelect={select}
                onSelectConversation={onSelectConversation}
                showStar
              />
            )}

            {fFavRepeaters.length > 0 && (
              <RepeaterGroup
                heading={t`Favorite Repeaters`}
                items={fFavRepeaters}
                onSelect={select}
                onSelectConversation={onSelectConversation}
                onRepeaterAutoLogin={onRepeaterAutoLogin}
                showStar
              />
            )}

            {fFavChannels.length > 0 && (
              <CommandGroup heading={t`Favorite Channels`}>
                {fFavChannels.map(({ channel: ch }) => (
                  <CommandItem
                    key={ch.key}
                    onSelect={() =>
                      select(() =>
                        onSelectConversation({ type: 'channel', id: ch.key, name: ch.name })
                      )
                    }
                  >
                    <Hash className="text-muted-foreground" />
                    <span>{ch.name}</span>
                    <Star className="ml-auto h-3 w-3 text-favorite" />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {fContacts.length > 0 && (
              <ContactGroup
                heading={t`Contacts`}
                items={fContacts}
                icon={User}
                onSelect={select}
                onSelectConversation={onSelectConversation}
              />
            )}

            {fRepeaters.length > 0 && (
              <RepeaterGroup
                heading={t`Repeaters`}
                items={fRepeaters}
                onSelect={select}
                onSelectConversation={onSelectConversation}
                onRepeaterAutoLogin={onRepeaterAutoLogin}
              />
            )}

            {fRooms.length > 0 && (
              <ContactGroup
                heading={t`Rooms`}
                items={fRooms}
                icon={MessageSquare}
                onSelect={select}
                onSelectConversation={onSelectConversation}
              />
            )}

            {fChannels.length > 0 && (
              <CommandGroup heading={t`Channels`}>
                {fChannels.map(({ channel: ch }) => (
                  <CommandItem
                    key={ch.key}
                    onSelect={() =>
                      select(() =>
                        onSelectConversation({ type: 'channel', id: ch.key, name: ch.name })
                      )
                    }
                  >
                    <Hash className="text-muted-foreground" />
                    <span>{ch.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>
              <Trans>Toggle palette</Trans>{' '}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">
                {String(formatForDisplay(APP_HOTKEYS.commandPalette.binding))}
              </kbd>
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => select(onOpenShortcutHelp)}
            >
              <Trans>Keyboard shortcuts</Trans>{' '}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">
                {String(formatForDisplay(APP_HOTKEYS.shortcutHelp.binding))}
              </kbd>
            </button>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function ContactGroup({
  heading,
  items,
  icon: Icon,
  showStar,
  onSelect,
  onSelectConversation,
}: {
  heading: string;
  items: SearchableContact[];
  icon: React.ComponentType<{ className?: string }>;
  showStar?: boolean;
  onSelect: (action: () => void) => void;
  onSelectConversation: (conv: Conversation) => void;
}) {
  return (
    <CommandGroup heading={heading}>
      {items.map(({ contact: c, displayName }) => (
        <CommandItem
          key={c.public_key}
          onSelect={() =>
            onSelect(() =>
              onSelectConversation({ type: 'contact', id: c.public_key, name: displayName })
            )
          }
        >
          <Icon className="text-muted-foreground" />
          <span>{displayName}</span>
          {showStar && <Star className="ml-auto h-3 w-3 text-favorite" />}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function RepeaterGroup({
  heading,
  items,
  showStar,
  onSelect,
  onSelectConversation,
  onRepeaterAutoLogin,
}: {
  heading: string;
  items: SearchableContact[];
  showStar?: boolean;
  onSelect: (action: () => void) => void;
  onSelectConversation: (conv: Conversation) => void;
  onRepeaterAutoLogin: (publicKey: string, displayName: string) => void;
}) {
  return (
    <CommandGroup heading={heading}>
      {items.flatMap(({ contact: c, displayName }) => [
        <CommandItem
          key={c.public_key}
          onSelect={() =>
            onSelect(() =>
              onSelectConversation({ type: 'contact', id: c.public_key, name: displayName })
            )
          }
        >
          <Waypoints className="text-muted-foreground" />
          <span>{displayName}</span>
          {showStar && <Star className="ml-auto h-3 w-3 text-favorite" />}
        </CommandItem>,
        <CommandItem
          key={`${c.public_key}-acl`}
          onSelect={() => onSelect(() => onRepeaterAutoLogin(c.public_key, displayName))}
        >
          <Waypoints className="text-muted-foreground" />
          <span>
            {displayName}{' '}
            <span className="text-muted-foreground">
              <Trans>(ACL login + load all)</Trans>
            </span>
          </span>
        </CommandItem>,
      ])}
    </CommandGroup>
  );
}
