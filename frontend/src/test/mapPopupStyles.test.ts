import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const mapStyles = readFileSync(path.join(process.cwd(), 'src/styles.css'), 'utf8');

function popupRule(selector: string): CSSStyleRule {
  const style = document.createElement('style');
  style.dataset.testid = 'map-popup-styles';
  style.textContent = mapStyles;
  document.head.append(style);
  const rule = Array.from(style.sheet?.cssRules ?? []).find(
    (candidate): candidate is CSSStyleRule =>
      'selectorText' in candidate && candidate.selectorText === selector
  );
  if (!rule) throw new Error(`Missing popup style rule: ${selector}`);
  return rule;
}

// CSSOM serializes colors (including those written as hex) into a canonical form.
// Compare parsed declarations so equivalent color notation does not fail CI.
function cssValue(property: 'color' | 'outline', value: string): string {
  const element = document.createElement('div');
  element.style.setProperty(property, value);
  document.body.append(element);
  const normalized = getComputedStyle(element).getPropertyValue(property);
  element.remove();
  return normalized;
}

describe('MapLibre popup close-button styles', () => {
  afterEach(() => {
    document
      .querySelectorAll('style[data-testid="map-popup-styles"]')
      .forEach((node) => node.remove());
    document.body.className = '';
    document.body.replaceChildren();
  });

  it.each(['light', 'original'])('keeps the close icon visible in the %s app theme', (theme) => {
    document.body.className = theme;
    const popup = document.createElement('div');
    popup.className = 'maplibregl-popup';
    const close = document.createElement('button');
    close.className = 'maplibregl-popup-close-button';
    popup.append(close);
    document.body.append(popup);
    popupRule('.maplibregl-popup .maplibregl-popup-close-button');

    expect(getComputedStyle(close).color).toBe('rgb(17, 24, 39)');
    expect(getComputedStyle(close).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('defines explicit hover and keyboard-focus affordances', () => {
    const hover = popupRule('.maplibregl-popup .maplibregl-popup-close-button:hover');
    const focus = popupRule('.maplibregl-popup .maplibregl-popup-close-button:focus-visible');

    expect(cssValue('color', hover.style.color)).toBe(cssValue('color', '#020617'));
    expect(hover.style.background).not.toBe('transparent');
    expect(cssValue('color', focus.style.color)).toBe(cssValue('color', '#020617'));
    expect(cssValue('outline', focus.style.outline)).toBe(cssValue('outline', '2px solid #2563eb'));
    expect(focus.style.getPropertyValue('outline-offset')).toBe('-2px');
  });
});
