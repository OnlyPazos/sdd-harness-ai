#!/usr/bin/env node
/*
 * Comprueba el contraste WCAG 2.x de los pares declarados en contrast-pairs.json
 * usando los valores reales de tokens/colors.json.
 *
 *   node design-system/scripts/check-contrast.mjs
 *
 * Sale con código 1 si algún par no alcanza su mínimo o referencia un token
 * inexistente.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const colors = JSON.parse(readFileSync(join(HERE, '..', 'tokens', 'colors.json'), 'utf8'));
const { pairs } = JSON.parse(readFileSync(join(HERE, 'contrast-pairs.json'), 'utf8'));

const MIN = { text: 4.5, 'large-text': 3, ui: 3 };

const resolve = (path) => path.split('.').reduce((node, key) => node?.[key], colors);

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Color no soportado (se espera #RRGGBB): ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
const rows = pairs.map(({ use, fg, bg, where }) => {
  const fgHex = resolve(fg);
  const bgHex = resolve(bg);
  if (typeof fgHex !== 'string' || typeof bgHex !== 'string') {
    failures++;
    return { where, pair: `${fg} / ${bg}`, ratio: '—', min: MIN[use], ok: 'TOKEN INEXISTENTE' };
  }
  const r = ratio(fgHex, bgHex);
  const ok = r >= MIN[use];
  if (!ok) failures++;
  return { where, pair: `${fg} / ${bg}`, ratio: r.toFixed(2), min: MIN[use], ok: ok ? 'OK' : 'FALLA' };
});

console.table(rows);
if (failures) {
  console.error(`${failures} par(es) no cumplen WCAG AA.`);
  process.exit(1);
}
console.log(`Los ${rows.length} pares cumplen WCAG AA.`);
