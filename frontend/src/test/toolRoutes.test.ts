import { describe, expect, it } from 'vitest';

import { validateMapSearch, validateMessageSearch } from '../routing/toolRoutes';

describe('tool route search validation', () => {
  it('passes a validated map focus to the map conversation', () => {
    expect(validateMapSearch({ focus: '  ABCD1234  ' })).toEqual({ focus: 'ABCD1234' });
  });

  it.each([{ focus: '' }, { focus: '   ' }, { focus: 42 }, { focus: null }])(
    'drops invalid or empty map focus: $focus',
    (search) => {
      expect(validateMapSearch(search)).toEqual({});
    }
  );

  it('normalizes bookmarkable message search queries', () => {
    expect(validateMessageSearch({ q: '  user:Alice hello  ' })).toEqual({
      q: 'user:Alice hello',
    });
    expect(validateMessageSearch({ q: '   ' })).toEqual({});
    expect(validateMessageSearch({ q: 42 })).toEqual({});
  });
});
