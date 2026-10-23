import { getLocale } from '@/i18n';
// Locale-deterministic integer formatting for UI statistics. Using an explicit
// the selected UI locale keeps formatting aligned with the active catalog.
export function formatLocaleNumber(value: number): string {
  return value.toLocaleString(getLocale());
}
