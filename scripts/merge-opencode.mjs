// Fusiona el opencode.json del harness en el de un proyecto sin perder su
// configuración propia. Lo usan install.sh e install.ps1 con --update.
//
// Uso: node scripts/merge-opencode.mjs <harness.json> <proyecto.json> <salida.json>
//
// - agent: los agentes del harness se reemplazan; los demás se conservan.
// - instructions: se añaden las del harness que falten.
// - permission.bash: se añaden o reemplazan las reglas globales del harness.
// - El resto de claves del proyecto (modelos, proveedores, MCP…) no se tocan.
// Sale con código 1 si alguno de los JSON no se puede leer.
import { readFileSync, writeFileSync } from 'node:fs';

const [srcPath, destPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error('Uso: node merge-opencode.mjs <harness.json> <proyecto.json> <salida.json>');
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

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

if (!dest.$schema && src.$schema) dest = { $schema: src.$schema, ...dest };

dest.instructions = [...new Set([...(dest.instructions ?? []), ...(src.instructions ?? [])])];

dest.agent = { ...(isObject(dest.agent) ? dest.agent : {}), ...src.agent };

if (isObject(src.permission?.bash)) {
  dest.permission = isObject(dest.permission) ? dest.permission : {};
  const bash = dest.permission.bash;
  // Una regla global en texto ("ask", "allow"…) pasa a ser el comodín "*".
  const base = isObject(bash) ? bash : typeof bash === 'string' ? { '*': bash } : {};
  dest.permission.bash = { ...base, ...src.permission.bash };
}

writeFileSync(outPath, JSON.stringify(dest, null, 2) + '\n');
