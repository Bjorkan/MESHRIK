import { describe, expect, it } from 'vitest';

import { getMapFocusPath, getToolConversation, validateMapSearch } from '../routing/toolRoutes';

describe('tool pathname routing', () => {
  it.each([
    ['/raw', 'raw'],
    ['/map', 'map'],
    ['/visualizer', 'visualizer'],
    ['/search', 'search'],
    ['/trace', 'trace'],
    ['/radio-activity', 'radio-activity'],
  ] as const)('derives the %s view from the pathname', (pathname, type) => {
    expect(getToolConversation(pathname, {})).toMatchObject({ type });
  });

  it('passes a validated map focus to the map conversation', () => {
    expect(getToolConversation('/map', { focus: '  ABCD1234  ' })).toMatchObject({
      type: 'map',
      mapFocusKey: 'ABCD1234',
    });
  });

  it.each([{ focus: '' }, { focus: '   ' }, { focus: 42 }, { focus: null }])(
    'drops invalid or empty map focus: $focus',
    (search) => {
      expect(validateMapSearch(search)).toEqual({});
      expect(getToolConversation('/map', search)).not.toHaveProperty('mapFocusKey');
    }
  );

  it('builds an encoded pathname map focus URL', () => {
    expect(getMapFocusPath('AB CD/12')).toBe('/map?focus=AB%20CD%2F12');
  });

  it('does not invent a tool conversation for an unrelated path', () => {
    expect(getToolConversation('/channel/example', {})).toBeNull();
  });
});
