// Fusiona el .claude/settings.json del harness en el de un proyecto sin
// perder su configuración propia. Lo usan install.sh e install.ps1 con --update.
//
// Uso: node scripts/merge-claude-settings.mjs <harness.json> <proyecto.json> <salida.json>
//
// - permissions.allow/deny/ask: se añaden las reglas del harness que falten
//   y se quitan las que el harness ya no usa (RETIRADAS).
// - hooks: en cada evento del harness, sus hooks (los que ejecutan
//   .claude/hooks/sdd-*) se reemplazan; los del proyecto se conservan.
// - El resto de claves del proyecto no se tocan.
// Sale con código 1 si alguno de los JSON no se puede leer.
import { readFileSync, writeFileSync } from 'node:fs';

const [srcPath, destPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error('Uso: node merge-claude-settings.mjs <harness.json> <proyecto.json> <salida.json>');
  process.exit(1);
}

let src, dest;
try {
  src = JSON.parse(readFileSync(srcPath, 'utf8'));
  dest = JSON.parse(readFileSync(destPath, 'utf8').replace(/^﻿/, ''));
} catch (err) {
  console.error(`No se puede leer como JSON: ${err.message}`);
  process.exit(1);
}

// Reglas que versiones anteriores del harness instalaban y ya no. Un "ask"
// gana a cualquier "allow", también al de settings.local.json, así que
// dejarlo impediría preautorizar ese comando en el proyecto.
const RETIRADAS = { ask: ['Bash(git merge:*)'] };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

if (isObject(src.permissions)) {
  dest.permissions = isObject(dest.permissions) ? dest.permissions : {};
  for (const key of ['allow', 'deny', 'ask']) {
    if (!Array.isArray(src.permissions[key])) continue;
    const own = (Array.isArray(dest.permissions[key]) ? dest.permissions[key] : [])
      .filter((r) => !(RETIRADAS[key] ?? []).includes(r));
    dest.permissions[key] = [...new Set([...own, ...src.permissions[key]])];
  }
}

const isHarness = (group) => (group.hooks ?? []).some((h) => /\.claude\/hooks\/sdd-/.test(h.command ?? ''));
if (isObject(src.hooks)) {
  dest.hooks = isObject(dest.hooks) ? dest.hooks : {};
  for (const [event, groups] of Object.entries(src.hooks)) {
    const own = Array.isArray(dest.hooks[event]) ? dest.hooks[event].filter((g) => !isHarness(g)) : [];
    dest.hooks[event] = [...own, ...groups];
  }
}

writeFileSync(outPath, JSON.stringify(dest, null, 2) + '\n');
