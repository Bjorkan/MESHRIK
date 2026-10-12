import { describe, expect, it } from 'vitest';

import { getEntityRoute, resolveEntityConversation } from '../routing/entityRoutes';
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
  it('parses stable channel and contact identities without display-name segments', () => {
    expect(getEntityRoute(`/channel/${channel.key}`)).toEqual({
      type: 'channel',
      id: channel.key,
    });
    expect(getEntityRoute(`/contact/${contact.public_key}`)).toEqual({
      type: 'contact',
      id: contact.public_key,
    });
    expect(getEntityRoute(`/channel/${channel.key}/Display%20Name`)).toBeNull();
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
      resolveEntityConversation({ type: 'contact', id: contact.public_key.slice(0, 12) }, [], [contact])
    ).toBeNull();
  });

  it('keeps canonical identity independent of a changed display name', () => {
    const renamed = { ...channel, name: 'Renamed Channel' };
    const route = getEntityRoute(`/channel/${channel.key}`)!;

    expect(resolveEntityConversation(route, [renamed], [])).toMatchObject({
      id: channel.key,
      name: 'Renamed Channel',
    });
  });
});
