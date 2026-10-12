import type { Channel, Contact, Conversation } from '../types';
import { getContactDisplayName } from '../utils/pubkey';

export interface EntityRoute {
  type: 'channel' | 'contact';
  id: string;
}

export function getEntityPath(route: EntityRoute): string {
  return `/${route.type}/${encodeURIComponent(route.id)}`;
}

export function getEntityRoute(pathname: string): EntityRoute | null {
  const match = /^\/(channel|contact)\/([^/]+)$/.exec(pathname);
  if (!match) return null;

  try {
    const id = decodeURIComponent(match[2]);
    return id ? { type: match[1] as EntityRoute['type'], id } : null;
  } catch {
    return null;
  }
}

export function resolveEntityConversation(
  route: EntityRoute,
  channels: Channel[],
  contacts: Contact[]
): Conversation | null {
  if (route.type === 'channel') {
    const channel = channels.find(
      (candidate) => candidate.key.toLowerCase() === route.id.toLowerCase()
    );
    return channel ? { type: 'channel', id: channel.key, name: channel.name } : null;
  }

  const contact = contacts.find(
    (candidate) => candidate.public_key.toLowerCase() === route.id.toLowerCase()
  );
  return contact
    ? {
        type: 'contact',
        id: contact.public_key,
        name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
      }
    : null;
}
