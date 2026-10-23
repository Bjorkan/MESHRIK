import { render, screen, waitFor } from '@testing-library/react';
import { plural } from '@lingui/core/macro';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageSelector } from '../components/settings/LanguageSelector';
import { CommandPalette } from '../components/CommandPalette';
import { NewMessageModal } from '../components/NewMessageModal';
import { SETTINGS_SECTION_LABELS } from '../components/settings/settingsConstants';
import {
  LANGUAGE_STORAGE_KEY,
  activateLanguage,
  getLanguagePreference,
  getLocale,
  resolveLanguage,
  setLanguagePreference,
  syncLanguagePreferenceFromStorage,
} from '../i18n';

describe('language preference', () => {
  beforeEach(async () => {
    localStorage.clear();
    await activateLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a supported browser language and falls back to English', () => {
    expect(resolveLanguage('auto', ['en-GB', 'sv-SE'])).toBe('en');
    expect(resolveLanguage('auto', ['sv-SE', 'en-GB'])).toBe('sv');
    expect(resolveLanguage('auto', ['de-DE'])).toBe('en');
    expect(resolveLanguage('en', ['sv-SE'])).toBe('en');
    expect(resolveLanguage('sv', ['en-GB'])).toBe('sv');
  });

  it('activates Swedish with Swedish formatting and document metadata', async () => {
    await setLanguagePreference('sv');

    expect(getLanguagePreference()).toBe('sv');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('sv');
    expect(document.documentElement.lang).toBe('sv');
    expect(getLocale()).toBe('sv-SE');
  });

  it('persists an explicit choice and removes storage for automatic detection', async () => {
    await setLanguagePreference('en');

    expect(getLanguagePreference()).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(getLocale()).toBe('en-US');

    await setLanguagePreference('auto');

    expect(getLanguagePreference()).toBe('auto');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('preserves the browser regional locale in automatic mode', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB']);

    await setLanguagePreference('auto');

    expect(getLocale()).toBe('en-GB');
  });

  it('keeps an in-memory choice when browser storage is unavailable', async () => {
    await activateLanguage('auto');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled');
    });

    await setLanguagePreference('en');

    expect(getLanguagePreference()).toBe('en');
  });

  it('reacts to preference changes made in another tab', async () => {
    render(<LanguageSelector />);
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();

    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await syncLanguagePreferenceFromStorage();

    expect(screen.getByRole('radio', { name: 'Automatic (browser language)' })).toBeChecked();
  });

  it('changes preference without remounting the surrounding settings form', async () => {
    const user = userEvent.setup();

    function SettingsDraft() {
      const [draft, setDraft] = useState('');
      return (
        <>
          <label>
            Draft
            <input value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <LanguageSelector />
        </>
      );
    }

    render(<SettingsDraft />);
    await user.type(screen.getByLabelText('Draft'), 'unchanged');
    await user.click(screen.getByRole('radio', { name: 'Svenska' }));

    expect(screen.getByLabelText('Draft')).toHaveValue('unchanged');
    expect(screen.getByRole('radio', { name: 'Svenska' })).toBeChecked();
    await waitFor(() => expect(screen.getByText('Språk')).toBeInTheDocument());
  });

  it('updates computed navigation labels and localized search without a remount', async () => {
    const user = userEvent.setup();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        contacts={[]}
        channels={[]}
        onSelectConversation={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenShortcutHelp={vi.fn()}
        onRepeaterAutoLogin={vi.fn()}
      />
    );

    await activateLanguage('sv');
    await waitFor(() => expect(screen.getByText('Kartvy')).toBeInTheDocument());
    expect(SETTINGS_SECTION_LABELS.local).toBe('Lokal konfiguration');

    await user.type(screen.getByRole('combobox'), 'kartvy');
    expect(screen.getByText('Kartvy')).toBeInTheDocument();
    expect(screen.queryByText('Nätverksvisualisering')).not.toBeInTheDocument();
  });

  it('uses Swedish ICU plurals and accessible dialog descriptions', async () => {
    await activateLanguage('sv');

    function PluralProbe() {
      return (
        <span>
          {plural(2, {
            one: 'Acknowledged, # echo — view paths',
            other: 'Acknowledged, # echoes — view paths',
          })}
        </span>
      );
    }

    render(
      <>
        <PluralProbe />
        <NewMessageModal
          open
          undecryptedCount={0}
          onClose={vi.fn()}
          onCreateContact={vi.fn()}
          onCreateChannel={vi.fn()}
          onCreateHashtagChannel={vi.fn()}
          onBulkAddHashtagChannels={vi.fn()}
        />
      </>
    );
    expect(screen.getByText('Bekräftat, 2 ekon – visa vägar')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Lägg till en ny kontakt genom att ange namn och publik nyckel'
    );
  });
});
