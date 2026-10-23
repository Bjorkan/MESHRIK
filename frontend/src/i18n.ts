import { i18n } from '@lingui/core';
import { messages as englishMessages } from './locales/en/messages.po';
import { messages as swedishMessages } from './locales/sv/messages.po';

export const LANGUAGE_STORAGE_KEY = 'meshrik-language';
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'sv', name: 'Svenska' },
] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = Language | 'auto';

const preferenceListeners = new Set<() => void>();

function readStoredLanguagePreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.some(({ code }) => code === value)) return value as Language;
  } catch {
    /* Storage can be disabled by browser privacy settings. */
  }
  return 'auto';
}

let currentPreference: LanguagePreference = readStoredLanguagePreference();

export function resolveLanguage(
  preference: string | null,
  browserLanguages: readonly string[] = navigator.languages
): Language {
  const candidates = preference && preference !== 'auto' ? [preference] : browserLanguages;
  for (const candidate of candidates) {
    const language = candidate.toLowerCase().split('-')[0];
    if (SUPPORTED_LANGUAGES.some(({ code }) => code === language)) return language as Language;
  }
  return 'en';
}

export function getLanguagePreference(): LanguagePreference {
  return currentPreference;
}

export function subscribeLanguagePreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function notifyPreferenceListeners() {
  preferenceListeners.forEach((listener) => listener());
}

// The English catalog is always available as the deterministic source fallback.
i18n.load({ en: englishMessages, sv: swedishMessages });
i18n.activate('en');

export async function activateLanguage(preference: LanguagePreference): Promise<void> {
  const preferenceChanged = currentPreference !== preference;
  currentPreference = preference;
  const language = resolveLanguage(preference);
  const languageChanged = i18n.locale !== language;
  i18n.activate(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (preferenceChanged || languageChanged) notifyPreferenceListeners();
}

export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  await activateLanguage(preference);
  try {
    if (preference === 'auto') localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    /* Changing language still works for this tab without storage. */
  }
}

/** Re-read a preference changed by another tab and update every local subscriber. */
export async function syncLanguagePreferenceFromStorage(): Promise<void> {
  await activateLanguage(readStoredLanguagePreference());
}

/** Automatic mode preserves the browser's regional formatting locale. */
export function getLocale(): string {
  if (currentPreference === 'auto' && typeof navigator !== 'undefined') {
    return navigator.languages?.[0] || navigator.language || i18n.locale;
  }
  return i18n.locale === 'en' ? 'en-US' : i18n.locale === 'sv' ? 'sv-SE' : i18n.locale;
}

export { i18n };
