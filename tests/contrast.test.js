const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const css = readFileSync(join(__dirname, '../src/manager/manager.css'), 'utf8');

function pair(name) {
  const match = css.match(new RegExp(`--${name}: light-dark\\(#([0-9a-f]{6}), #([0-9a-f]{6})\\)`));
  assert.ok(match, `missing ${name} light-dark pair`);
  return match.slice(1).map(hexToRgb);
}

function hexToRgb(hex) {
  return hex.match(/../g).map(value => Number.parseInt(value, 16));
}

function mix(foreground, amount, background) {
  return foreground.map((value, index) => value * amount + background[index] * (1 - amount));
}

function luminance(rgb) {
  const [red, green, blue] = rgb.map(value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function expectContrast(label, foreground, background, minimum) {
  const ratio = contrast(foreground, background);
  assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(2)}:1 is below ${minimum}:1`);
}

test('manager color roles meet WCAG 2.2 contrast targets', () => {
  assert.match(css, /\.search-field\s*\{[^}]*border: 1px solid var\(--overlay0\)/s);
  assert.match(css, /\.shortcut-panel,\s*\.editor-panel\s*\{[^}]*border: 1px solid var\(--border\)/s);
  assert.match(css, /\.shortcut-item:hover \.shortcut-url,[^}]*color: var\(--text\)/s);
  assert.match(css, /\.variable-badge\s*\{[^}]*background: color-mix\(in srgb, var\(--blue\) 16%, var\(--surface\)\)/s);

  const base = pair('base');
  const mantle = pair('mantle');
  const surface1 = pair('surface1');
  const surface0 = pair('surface0');
  const surface = [hexToRgb('ffffff'), surface0[1]];
  const surfaceHover = [surface0[0], surface1[1]];
  const text = pair('text');
  const muted = pair('muted');
  const overlay = pair('overlay0');
  const blue = pair('blue');
  const blueText = pair('blue-text');
  const yellow = pair('yellow');
  const yellowBorder = pair('yellow-border');
  const greenBorder = pair('green-border');
  const red = pair('red');

  for (const mode of [0, 1]) {
    const name = mode === 0 ? 'light' : 'dark';
    expectContrast(`${name} text on base`, text[mode], base[mode], 4.5);
    expectContrast(`${name} text on surface`, text[mode], surface[mode], 4.5);
    expectContrast(`${name} muted text on base`, muted[mode], base[mode], 4.5);
    expectContrast(`${name} muted text on surface`, muted[mode], surface[mode], 4.5);
    expectContrast(`${name} text on hover`, text[mode], surfaceHover[mode], 4.5);
    expectContrast(`${name} muted icon on hover`, muted[mode], surfaceHover[mode], 3);
    expectContrast(`${name} input boundary`, overlay[mode], base[mode], 3);
    expectContrast(`${name} focus indicator`, blue[mode], base[mode], 3);
    expectContrast(`${name} fallback text`, blueText[mode], mantle[mode], 4.5);
    expectContrast(`${name} warning border`, yellowBorder[mode], surface[mode], 3);
    expectContrast(`${name} error border`, red[mode], surface[mode], 3);
    expectContrast(`${name} toast border`, greenBorder[mode], mantle[mode], 3);

    const variableBackground = mix(blue[mode], 0.16, surface[mode]);
    expectContrast(`${name} variable badge`, blueText[mode], variableBackground, 4.5);
    const warningBackground = mix(yellow[mode], 0.1, surface[mode]);
    expectContrast(`${name} warning text`, text[mode], warningBackground, 4.5);
  }
});
