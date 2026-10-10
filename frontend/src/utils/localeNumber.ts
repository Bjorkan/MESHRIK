// Locale-deterministic integer formatting for UI statistics. Using an explicit
// 'en-US' locale keeps rendered numbers (e.g. "391,757") stable across
// environments regardless of the OS/system locale.
export function formatLocaleNumber(value: number): string {
  return value.toLocaleString('en-US');
}
