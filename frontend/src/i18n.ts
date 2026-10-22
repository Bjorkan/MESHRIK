import { i18n } from '@lingui/core';
import { messages } from './locales/en/messages.po';

export const LANGUAGE_STORAGE_KEY = 'meshrik-language';
export const SUPPORTED_LANGUAGES = [{ code: 'en', name: 'English' }] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = Language | 'auto';

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
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.some(({ code }) => code === value)) return value as Language;
  } catch {
    /* Storage can be disabled by browser privacy settings. */
  }
  return 'auto';
}

// The English catalog is always available as the deterministic source fallback.
i18n.load('en', messages);
i18n.activate('en');

export async function activateLanguage(preference: LanguagePreference): Promise<void> {
  const language = resolveLanguage(preference);
  i18n.activate(language);
  document.documentElement.lang = language;
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

/** Formatting follows the selected language, never an unrelated browser locale. */
export function getLocale(): string {
  return i18n.locale === 'en' ? 'en-US' : i18n.locale;
}

export { i18n };
