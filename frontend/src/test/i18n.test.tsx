import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { LanguageSelector } from '../components/settings/LanguageSelector';
import {
  LANGUAGE_STORAGE_KEY,
  activateLanguage,
  getLanguagePreference,
  getLocale,
  resolveLanguage,
  setLanguagePreference,
} from '../i18n';

describe('language preference', () => {
  beforeEach(async () => {
    localStorage.clear();
    await activateLanguage('en');
  });

  it('uses a supported browser language and falls back to English', () => {
    expect(resolveLanguage('auto', ['en-GB', 'sv-SE'])).toBe('en');
    expect(resolveLanguage('auto', ['de-DE'])).toBe('en');
    expect(resolveLanguage('en', ['sv-SE'])).toBe('en');
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
    await user.click(screen.getByRole('radio', { name: 'English' }));

    expect(screen.getByLabelText('Draft')).toHaveValue('unchanged');
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
  });
});
