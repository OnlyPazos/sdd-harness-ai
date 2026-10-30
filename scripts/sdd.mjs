// Acceso acotado a specs/ para los roles del pipeline: cada rol lee solo lo
// que necesita en vez de cargar project_specs.md y work_items.md enteros
// (en proyectos reales pasan de 100 KB y ralentizan cada llamada al modelo).
//
// Uso: node scripts/sdd.mjs <comando> [args]
//   estado [--todos]          resumen de Work Items: en curso, siguiente que
//                             se puede empezar y pendientes (los integrados,
//                             solo con --todos)
//   show <WI>                 contexto común del plan, el Work Item, el
//                             estado de sus dependencias y sus Acceptance
//                             Checks y Decisiones de diseño
//   reglas                    "Reglas base de stack" de la spec, con el
//                             contenido de las plantillas que referencie
//   estado <WI> <nuevo> [--nota "texto"]
//                             cambia el Estado (solo transiciones válidas de
//                             AGENTS.md) y, con --nota, la añade al Historial QA
//   nota <WI> "texto"         añade una entrada al Historial QA sin cambiar
//                             el Estado (p. ej. un BLOQUEADO de qa)
//   archivar                  mueve los Work Items integrados a
//                             specs/work_items.done.md
//
// Los Work Items se buscan en work_items.md y en work_items.done.md.
// Sale con código 1 ante un error de uso o de datos.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'specs', 'project_specs.md');
const PLAN = join(ROOT, 'specs', 'work_items.md');
const DONE = join(ROOT, 'specs', 'work_items.done.md');
const ESTADOS = ['pendiente', 'en-progreso', 'qa', 'verificado', 'integrado'];
const TRANSICIONES = {
  pendiente: ['en-progreso'],
  'en-progreso': ['qa'],
  qa: ['verificado', 'en-progreso'],
  verificado: ['integrado'],
};
// Una entrada del Historial QA es un resumen: la evidencia completa va en el
// informe del rol, no en el plan, que todos los roles leen.
const MAX_NOTA = 500;

const fallo = (msg) => {
  console.error(msg);
  process.exit(1);
};

const leer = (path) => {
  if (!existsSync(path)) return null;
  const texto = readFileSync(path, 'utf8');
  return { path, eol: texto.includes('\r\n') ? '\r\n' : '\n', lineas: texto.split(/\r?\n/) };
};
const guardar = (doc) => writeFileSync(doc.path, doc.lineas.join(doc.eol));

// Divide un documento en secciones que empiezan por una cabecera que cumple
// `re`; cada sección acaba antes de la siguiente cabecera de nivel <= nivel.
const secciones = (doc, re, nivel) => {
  const out = [];
  const corte = new RegExp(`^#{1,${nivel}} `);
  for (let i = 0; i < doc.lineas.length; i++) {
    const m = doc.lineas[i].match(re);
    if (!m) continue;
    let fin = i + 1;
    while (fin < doc.lineas.length && !corte.test(doc.lineas[fin])) fin++;
    out.push({ id: m[1], ini: i, fin, doc });
  }
  return out;
};
const texto = (s) => s.doc.lineas.slice(s.ini, s.fin).join('\n').trimEnd();

const campo = (s, nombre) => {
  for (let i = s.ini; i < s.fin; i++) {
    const m = s.doc.lineas[i].match(new RegExp(`^- ${nombre}:\\s*(.*)$`));
    if (m) return { i, valor: m[1].trim() };
  }
  return null;
};
const ids = (valor, re) => (valor ?? '').match(re) ?? [];
const RE_WI = /\bWI-[A-Za-z0-9]+-[A-Za-z0-9]+\b/g;
const RE_AC = /\bAC-\d+[a-z]?\b/g;

const cargarPlan = () => {
  const plan = leer(PLAN);
  if (!plan) fallo('No existe specs/work_items.md. Lo genera el rol planner.');
  const done = leer(DONE);
  const wis = [plan, done].filter(Boolean).flatMap((d) => secciones(d, /^## (WI-\S+)\s*$/, 2));
  for (const w of wis) {
    w.estado = (campo(w, 'Estado')?.valor ?? '').replace(/`/g, '');
    w.deps = ids(campo(w, 'Depende de')?.valor, RE_WI);
    w.acs = ids(campo(w, 'Acceptance Checks')?.valor, RE_AC);
    w.rama = campo(w, 'Rama sugerida')?.valor ?? '';
  }
  return { plan, done, wis, porId: new Map(wis.map((w) => [w.id, w])) };
};
const buscar = (p, id) => p.porId.get(id) ?? fallo(`No existe ${id} en specs/work_items.md ni en specs/work_items.done.md.`);

const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const anotar = (w, nota) => {
  if (nota.length > MAX_NOTA) {
    fallo(`La nota tiene ${nota.length} caracteres (máximo ${MAX_NOTA}). Resume el resultado y el defecto; la evidencia completa va en tu informe.`);
  }
  const l = w.doc.lineas;
  const entrada = `  - ${hoy()} · ${nota.replace(/\s*\n\s*/g, ' ')}`;
  const h = campo(w, 'Historial QA');
  let pos;
  if (!h) {
    pos = w.fin;
    while (pos > w.ini + 1 && l[pos - 1].trim() === '') pos--;
    l.splice(pos, 0, '- Historial QA:');
    pos++;
  } else {
    if (/^\[\s*\]$/.test(h.valor)) l[h.i] = '- Historial QA:';
    pos = h.i + 1;
    while (pos < w.fin && /^\s{2,}\S/.test(l[pos])) pos++;
  }
  l.splice(pos, 0, entrada);
};

const [cmd, ...args] = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

switch (cmd) {
  case 'estado': {
    const nota = opt('--nota');
    const todos = args.includes('--todos');
    const p = cargarPlan();
    if (args[0] && !args[0].startsWith('--')) {
      const [id, nuevo] = args;
      const w = buscar(p, id);
      if (!ESTADOS.includes(nuevo)) fallo(`Estado no válido: ${nuevo}. Válidos: ${ESTADOS.join(', ')}.`);
      if (!(TRANSICIONES[w.estado] ?? []).includes(nuevo)) {
        fallo(`${id} está en "${w.estado}": no puede pasar a "${nuevo}". Transiciones válidas: ${(TRANSICIONES[w.estado] ?? []).join(', ') || 'ninguna'}.`);
      }
      const e = campo(w, 'Estado') ?? fallo(`${id} no tiene línea "- Estado:".`);
      w.doc.lineas[e.i] = `- Estado: ${nuevo}`;
      if (nota) anotar(w, nota);
      guardar(w.doc);
      console.log(`${id}: ${w.estado} → ${nuevo}${nota ? ' (nota añadida al Historial QA)' : ''}`);
      break;
    }
    const listos = (w) => w.deps.every((d) => p.porId.get(d)?.estado === 'integrado');
    const fila = (w) => `  ${w.id.padEnd(14)} ${w.estado.padEnd(11)} ${w.deps.length ? `depende de ${w.deps.map((d) => `${d} (${p.porId.get(d)?.estado ?? '¿no existe?'})`).join(', ')}` : ''}`;
    const enCurso = p.wis.filter((w) => ['en-progreso', 'qa', 'verificado'].includes(w.estado));
    const pendientes = p.wis.filter((w) => w.estado === 'pendiente');
    const integrados = p.wis.filter((w) => w.estado === 'integrado');
    const otros = p.wis.filter((w) => !ESTADOS.includes(w.estado));
    console.log(`${p.wis.length} Work Items: ${integrados.length} integrados, ${enCurso.length} en curso, ${pendientes.length} pendientes.`);
    if (enCurso.length) console.log(`En curso:\n${enCurso.map(fila).join('\n')}`);
    const siguiente = pendientes.find(listos);
    console.log(siguiente ? `Siguiente que se puede empezar: ${siguiente.id} (${siguiente.rama})` : 'Ningún pendiente tiene todas sus dependencias integradas.');
    if (pendientes.length) console.log(`Pendientes:\n${pendientes.map(fila).join('\n')}`);
    if (otros.length) console.log(`Con Estado no válido:\n${otros.map(fila).join('\n')}`);
    if (todos && integrados.length) console.log(`Integrados:\n${integrados.map(fila).join('\n')}`);
    break;
  }

  case 'nota': {
    const [id, nota] = args;
    if (!nota) fallo('Uso: node scripts/sdd.mjs nota <WI> "texto"');
    const w = buscar(cargarPlan(), id);
    anotar(w, nota);
    guardar(w.doc);
    console.log(`${id}: nota añadida al Historial QA (Estado sin cambios: ${w.estado}).`);
    break;
  }

  case 'show': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs show <WI>');
    const p = cargarPlan();
    const w = buscar(p, id);
    const primero = p.plan.lineas.findIndex((l) => /^## WI-/.test(l));
    const comun = p.plan.lineas.slice(0, primero < 0 ? p.plan.lineas.length : primero).join('\n').trim();
    if (comun) console.log(`===== Contexto común (specs/work_items.md) =====\n${comun}\n`);
    console.log(`===== ${id} =====\n${texto(w)}\n`);
    if (w.deps.length) {
      console.log('===== Dependencias =====');
      for (const d of w.deps) console.log(`- ${d}: ${p.porId.get(d)?.estado ?? 'no existe'}`);
      console.log();
    }
    const spec = leer(SPEC);
    if (!spec) fallo('No existe specs/project_specs.md.');
    const acs = secciones(spec, /^### (AC-\d+[a-z]?)\b/, 3).filter((s) => w.acs.includes(s.id));
    const faltan = w.acs.filter((a) => !acs.some((s) => s.id === a));
    console.log(`===== Acceptance Checks (specs/project_specs.md) =====\n${acs.map(texto).join('\n\n')}`);
    if (faltan.length) console.log(`\n(No encontrados en la spec: ${faltan.join(', ')})`);
    const ds = secciones(spec, /^### (D-\d+[a-z]?)\b/, 3).filter((s) => {
      const prueba = s.doc.lineas.slice(s.ini, s.fin).find((l) => /^Prueba/.test(l)) ?? texto(s);
      return ids(prueba, RE_AC).some((a) => w.acs.includes(a));
    });
    if (ds.length) console.log(`\n===== Decisiones de diseño que prueban esos checks =====\n${ds.map(texto).join('\n\n')}`);
    break;
  }

  case 'reglas': {
    const spec = leer(SPEC) ?? fallo('No existe specs/project_specs.md.');
    const ini = spec.lineas.findIndex((l) => /^## Reglas base de stack\s*$/.test(l));
    if (ini < 0) fallo('La spec no tiene sección "## Reglas base de stack".');
    // Las plantillas copiadas tal cual traen sus propios "#" y "##": la
    // sección acaba en la siguiente sección de la estructura de la spec.
    let fin = spec.lineas.findIndex((l, i) => i > ini && /^## (Glosario|Contextos|Acceptance|Decisiones|Preguntas)/.test(l));
    if (fin < 0) fin = spec.lineas.length;
    const cuerpo = spec.lineas.slice(ini, fin).join('\n').trimEnd();
    console.log(cuerpo);
    for (const ref of new Set(cuerpo.match(/specs\/templates\/[\w.-]+\.md/g) ?? [])) {
      const f = leer(join(ROOT, ref));
      console.log(`\n===== ${ref} =====\n${f ? f.lineas.join('\n').trim() : '(no existe)'}`);
    }
    break;
  }

  case 'archivar': {
    const p = cargarPlan();
    const mover = p.wis.filter((w) => w.doc === p.plan && w.estado === 'integrado');
    if (!mover.length) {
      console.log('No hay Work Items integrados que archivar.');
      break;
    }
    const done = p.done ?? {
      path: DONE,
      eol: p.plan.eol,
      lineas: ['# Work Items integrados', '', 'Archivados desde `specs/work_items.md` con `node scripts/sdd.mjs archivar`. `sdd.mjs` los sigue leyendo.', ''],
    };
    while (done.lineas.length && done.lineas.at(-1).trim() === '') done.lineas.pop();
    for (const w of mover) done.lineas.push('', ...texto(w).split('\n'));
    done.lineas.push('');
    for (const w of [...mover].reverse()) p.plan.lineas.splice(w.ini, w.fin - w.ini);
    guardar(done);
    guardar(p.plan);
    console.log(`Archivados ${mover.length} Work Items en specs/work_items.done.md: ${mover.map((w) => w.id).join(', ')}`);
    break;
  }

  default:
    fallo('Uso: node scripts/sdd.mjs <estado [--todos] | show <WI> | reglas | estado <WI> <nuevo> [--nota "texto"] | nota <WI> "texto" | archivar>');
}
