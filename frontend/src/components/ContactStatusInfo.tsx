import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from './ui/sonner';
import { formatTime } from '../utils/messageParser';
import {
  isValidLocation,
  calculateDistance,
  formatDistance,
  formatRouteLabel,
  getEffectiveContactRoute,
} from '../utils/pathUtils';
import { handleKeyboardActivate } from '../utils/a11y';
import type { Contact } from '../types';
import { useDistanceUnit } from '../contexts/DistanceUnitContext';
import { ContactRoutingOverrideModal } from './ContactRoutingOverrideModal';

interface ContactStatusInfoProps {
  contact: Contact;
  ourLat: number | null;
  ourLon: number | null;
}

/**
 * Renders the "(Last heard: ..., N hops, lat, lon (dist))" status line
 * shared between ChatHeader and RepeaterDashboard.
 */
export function ContactStatusInfo({ contact, ourLat, ourLon }: ContactStatusInfoProps) {
  useLingui();

  const { distanceUnit } = useDistanceUnit();
  const [routingModalOpen, setRoutingModalOpen] = useState(false);
  const parts: ReactNode[] = [];
  const effectiveRoute = getEffectiveContactRoute(contact);

  if (contact.last_seen) {
    parts.push(`Last heard: ${formatTime(contact.last_seen)}`);
  }

  parts.push(
    <span
      key="path"
      className="cursor-pointer underline underline-offset-2 decoration-muted-foreground/50 hover:text-primary"
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyboardActivate}
      onClick={(e) => {
        e.stopPropagation();
        setRoutingModalOpen(true);
      }}
      title={t`Click to edit routing override`}
    >
      {formatRouteLabel(effectiveRoute.pathLen)}
      {effectiveRoute.forced && (
        <span className="text-destructive">
          <Trans> (forced)</Trans>
        </span>
      )}
    </span>
  );

  if (isValidLocation(contact.lat, contact.lon)) {
    const distFromUs =
      ourLat != null && ourLon != null && isValidLocation(ourLat, ourLon)
        ? calculateDistance(ourLat, ourLon, contact.lat, contact.lon)
        : null;
    parts.push(
      <span key="coords">
        <Link
          to="/map"
          search={{ focus: contact.public_key }}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono cursor-pointer hover:text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
          title={t`View on map`}
        >
          {contact.lat!.toFixed(3)}, {contact.lon!.toFixed(3)}
        </Link>
        {distFromUs !== null && ` (${formatDistance(distFromUs, distanceUnit)})`}
      </span>
    );
  }

  if (parts.length === 0) return null;

  return (
    <>
      <span className="font-normal text-sm text-muted-foreground flex-shrink-0">
        (
        {parts.map((part, i) => (
          <span key={i}>
            {i > 0 && ', '}
            {part}
          </span>
        ))}
        )
      </span>
      <ContactRoutingOverrideModal
        open={routingModalOpen}
        onClose={() => setRoutingModalOpen(false)}
        contact={contact}
        onSaved={(message) => toast.success(message)}
        onError={(message) => toast.error(message)}
      />
    </>
  );
}
