import { useState, useSyncExternalStore } from 'react';
import { Trans } from '@lingui/react/macro';
import {
  SUPPORTED_LANGUAGES,
  getLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
  type LanguagePreference,
} from '../../i18n';

export function LanguageSelector() {
  const preference = useSyncExternalStore(
    subscribeLanguagePreference,
    getLanguagePreference,
    getLanguagePreference
  );
  const [pending, setPending] = useState(false);
  return (
    <fieldset className="space-y-3" disabled={pending}>
      <legend className="text-base font-semibold tracking-tight">
        <Trans>Language</Trans>
      </legend>
      <p className="text-[0.8125rem] text-muted-foreground">
        <Trans>
          Only affects this browser. Radio settings and message contents stay unchanged.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-3">
        {[
          { code: 'auto', name: <Trans>Automatic (browser language)</Trans> },
          ...SUPPORTED_LANGUAGES,
        ].map(({ code, name }) => (
          <label
            key={code}
            className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm"
          >
            <input
              type="radio"
              name="language"
              value={code}
              checked={preference === code}
              onChange={async () => {
                setPending(true);
                try {
                  await setLanguagePreference(code as LanguagePreference);
                } finally {
                  setPending(false);
                }
              }}
            />
            {name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
