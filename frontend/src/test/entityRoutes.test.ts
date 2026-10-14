import { describe, expect, it } from 'vitest';

import {
  getEntityPath,
  resolveEntityConversation,
  validateEntitySearch,
} from '../routing/entityRoutes';
import type { Channel, Contact } from '../types';

const channel: Channel = {
  key: 'ABCDEF0123456789ABCDEF0123456789',
  name: 'Display Name',
  is_hashtag: false,
  on_radio: true,
  last_read_at: null,
  favorite: false,
  muted: false,
};

const contact: Contact = {
  public_key: 'ab'.repeat(32),
  name: 'Alice',
  type: 1,
  flags: 0,
  direct_path: null,
  direct_path_len: -1,
  direct_path_hash_mode: -1,
  last_advert: null,
  lat: null,
  lon: null,
  last_seen: null,
  first_seen: null,
  last_read_at: null,
  on_radio: false,
  favorite: false,
  last_contacted: null,
};

describe('entity pathname routing', () => {
  it('builds encoded canonical entity paths', () => {
    expect(getEntityPath({ type: 'channel', id: 'AB CD/12' })).toBe('/channel/AB%20CD%2F12');
    expect(getEntityPath({ type: 'contact', id: contact.public_key })).toBe(
      `/contact/${contact.public_key}`
    );
  });

  it('validates positive message anchors without preserving invalid URL state', () => {
    expect(validateEntitySearch({ message: '42' })).toEqual({ message: 42 });
    expect(validateEntitySearch({ message: 7 })).toEqual({ message: 7 });
    expect(validateEntitySearch({ message: '0' })).toEqual({});
    expect(validateEntitySearch({ message: '-1' })).toEqual({});
    expect(validateEntitySearch({ message: '1.5' })).toEqual({});
    expect(validateEntitySearch({ message: 'not-a-number' })).toEqual({});
  });

  it('resolves only exact stable identities', () => {
    expect(resolveEntityConversation({ type: 'channel', id: channel.key }, [channel], [])).toEqual({
      type: 'channel',
      id: channel.key,
      name: channel.name,
    });
    expect(
      resolveEntityConversation({ type: 'contact', id: contact.public_key }, [], [contact])
    ).toMatchObject({ type: 'contact', id: contact.public_key, name: 'Alice' });
    expect(resolveEntityConversation({ type: 'contact', id: 'Alice' }, [], [contact])).toBeNull();
    expect(
      resolveEntityConversation(
        { type: 'contact', id: contact.public_key.slice(0, 12) },
        [],
        [contact]
      )
    ).toBeNull();
  });

  it('keeps canonical identity independent of a changed display name', () => {
    const renamed = { ...channel, name: 'Renamed Channel' };
    const route = { type: 'channel', id: channel.key } as const;

    expect(resolveEntityConversation(route, [renamed], [])).toMatchObject({
      id: channel.key,
      name: 'Renamed Channel',
    });
  });
});
