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
//   rama <WI>                 crea la "Rama sugerida" desde la rama de
//                             integración (o cambia a ella si ya existe),
//                             tras comprobar que sus dependencias están
//                             integradas
//   integrar <WI>             commitea el Estado que dejó qa, mergea la rama
//                             del Work Item en integración (--no-ff), lo pasa
//                             a integrado y archiva si no quedan Work Items
//                             abiertos. Ante un conflicto aborta el merge y
//                             sale con código 1 sin tocar nada más
//
// rama e integrar hacen el camino normal de git-manager sin un modelo de
// por medio. Lo que se salga de ese camino (sin rama de integración,
// cambios sin commitear, commits de otro Work Item, conflictos) lo
// rechazan con un mensaje para que lo resuelva git-manager.
//
// Los Work Items se buscan en work_items.md y en work_items.done.md.
// Sale con código 1 ante un error de uso o de datos.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

const cambiarEstado = (w, nuevo, nota) => {
  if (!ESTADOS.includes(nuevo)) fallo(`Estado no válido: ${nuevo}. Válidos: ${ESTADOS.join(', ')}.`);
  if (!(TRANSICIONES[w.estado] ?? []).includes(nuevo)) {
    fallo(`${w.id} está en "${w.estado}": no puede pasar a "${nuevo}". Transiciones válidas: ${(TRANSICIONES[w.estado] ?? []).join(', ') || 'ninguna'}.`);
  }
  const e = campo(w, 'Estado') ?? fallo(`${w.id} no tiene línea "- Estado:".`);
  w.doc.lineas[e.i] = `- Estado: ${nuevo}`;
  if (nota) anotar(w, nota);
  guardar(w.doc);
};

// Mueve los integrados a work_items.done.md y devuelve los movidos.
const archivar = (p) => {
  const mover = p.wis.filter((w) => w.doc === p.plan && w.estado === 'integrado');
  if (!mover.length) return mover;
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
  return mover;
};

const ABIERTOS = ['en-progreso', 'qa', 'verificado'];

const ejecutarGit = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const git = (...args) => {
  const r = ejecutarGit(args);
  if (r.error) fallo(`No se pudo ejecutar git: ${r.error.message}`);
  if (r.status !== 0) fallo(`git ${args.join(' ')} falló:\n${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const lineasDe = (salida) => (salida ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const ramaActual = () => git('branch', '--show-current');
const existeRama = (rama) => git('branch', '--list', rama) !== '';
// Rutas con cambios sin commitear, incluidos archivos nuevos sin seguimiento.
const sinCommitear = () => ejecutarGit(['status', '--porcelain', '--untracked-files=all']).stdout
  .split('\n').filter((l) => l.trim())
  .map((l) => l.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, ''));
const ramaIntegracion = () => {
  const ramas = lineasDe(git('branch', '--list', 'integration/*')).map((l) => l.replace(/^[*+]\s*/, ''));
  if (ramas.length === 1) return ramas[0];
  fallo(ramas.length
    ? `Hay varias ramas de integración (${ramas.join(', ')}): decide cuál con git-manager.`
    : 'No existe ninguna rama integration/<proyecto>: créala con git-manager (solo la primera vez).');
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
      const antes = w.estado;
      cambiarEstado(w, nuevo, nota);
      console.log(`${id}: ${antes} → ${nuevo}${nota ? ' (nota añadida al Historial QA)' : ''}`);
      break;
    }
    const listos = (w) => w.deps.every((d) => p.porId.get(d)?.estado === 'integrado');
    const fila = (w) => `  ${w.id.padEnd(14)} ${w.estado.padEnd(11)} ${w.deps.length ? `depende de ${w.deps.map((d) => `${d} (${p.porId.get(d)?.estado ?? '¿no existe?'})`).join(', ')}` : ''}`;
    const enCurso = p.wis.filter((w) => ABIERTOS.includes(w.estado));
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
    const mover = archivar(cargarPlan());
    console.log(mover.length
      ? `Archivados ${mover.length} Work Items en specs/work_items.done.md: ${mover.map((w) => w.id).join(', ')}`
      : 'No hay Work Items integrados que archivar.');
    break;
  }

  case 'rama': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs rama <WI>');
    const sucios = sinCommitear();
    if (sucios.length) fallo(`Hay cambios sin commitear (${sucios.join(', ')}). Resuélvelo con git-manager antes de cambiar de rama.`);
    const integ = ramaIntegracion();
    const rama = buscar(cargarPlan(), id).rama || fallo(`${id} no tiene "Rama sugerida".`);
    if (existeRama(rama)) {
      if (ramaActual() !== rama) git('checkout', rama);
      console.log(`${id}: en ${rama} (ya existía). Estado: ${buscar(cargarPlan(), id).estado}.`);
      break;
    }
    // Lo integrado lo sabe el plan de la rama de integración.
    if (ramaActual() !== integ) git('checkout', integ);
    const p = cargarPlan();
    const w = buscar(p, id);
    if (w.estado !== 'pendiente') fallo(`${id} está en "${w.estado}" en ${integ} y no existe su rama ${rama}: revísalo con git-manager.`);
    const faltan = w.deps.filter((d) => p.porId.get(d)?.estado !== 'integrado');
    if (faltan.length) fallo(`${id} depende de Work Items sin integrar: ${faltan.map((d) => `${d} (${p.porId.get(d)?.estado ?? 'no existe'})`).join(', ')}.`);
    git('checkout', '-b', rama);
    console.log(`${id}: creada ${rama} desde ${integ}. Siguiente rol: builder.`);
    break;
  }

  case 'integrar': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs integrar <WI>');
    const integ = ramaIntegracion();
    const rama = buscar(cargarPlan(), id).rama || fallo(`${id} no tiene "Rama sugerida".`);
    if (!existeRama(rama)) fallo(`No existe la rama ${rama}.`);
    if (ramaActual() !== rama) {
      const sucios = sinCommitear();
      if (sucios.length) fallo(`Estás en ${ramaActual()} con cambios sin commitear (${sucios.join(', ')}): revísalo con git-manager.`);
      git('checkout', rama);
    }
    const ajenos = sinCommitear().filter((f) => f !== 'specs/work_items.md');
    if (ajenos.length) fallo(`${rama} tiene cambios sin commitear fuera de specs/work_items.md (${ajenos.join(', ')}): revísalo con git-manager.`);
    const w = buscar(cargarPlan(), id);
    if (w.estado !== 'verificado') fallo(`${id} está en "${w.estado}", no en "verificado": no se integra sin el PASS de qa.`);
    const hechos = [];
    if (sinCommitear().length) {
      git('add', 'specs/work_items.md');
      git('commit', '-m', `chore(${id}): verificado por QA`);
      hechos.push(`chore(${id}): verificado por QA (en ${rama})`);
    }
    const commits = lineasDe(git('log', '--format=%s', `${integ}..${rama}`));
    if (!commits.length) fallo(`${rama} no tiene commits que no estén ya en ${integ}.`);
    const otros = commits.filter((c) => !c.includes(id));
    if (otros.length) fallo(`${rama} tiene commits que no mencionan ${id}; revísalo con git-manager antes de integrar:\n${otros.map((c) => `  ${c}`).join('\n')}`);
    // Descripción del merge: el primer commit de trabajo de la rama.
    const trabajo = [...commits].reverse().find((c) => !/^chore\b/.test(c));
    const desc = trabajo ? trabajo.replace(/^[^:]*:\s*/, '') : w.acs.join(', ') || id;
    git('checkout', integ);
    const m = ejecutarGit(['merge', '--no-ff', rama, '-m', `merge(${id}): ${desc}`]);
    if (m.status !== 0) {
      const conflictos = lineasDe(ejecutarGit(['diff', '--name-only', '--diff-filter=U']).stdout);
      if (conflictos.length) {
        ejecutarGit(['merge', '--abort']);
        fallo(`CONFLICTO al mergear ${rama} en ${integ}: ${conflictos.join(', ')}. Merge abortado, sigues en ${integ}; resuélvelo con git-manager.`);
      }
      fallo(`git merge falló:\n${(m.stderr || m.stdout).trim()}`);
    }
    hechos.push(`merge(${id}): ${desc}`);
    cambiarEstado(buscar(cargarPlan(), id), 'integrado');
    git('add', 'specs/work_items.md');
    git('commit', '-m', `chore(${id}): integrado`);
    hechos.push(`chore(${id}): integrado`);
    const p = cargarPlan();
    const abiertos = p.wis.filter((x) => ABIERTOS.includes(x.estado));
    if (abiertos.length) {
      hechos.push(`sin archivar: siguen abiertos ${abiertos.map((x) => x.id).join(', ')}`);
    } else {
      const movidos = archivar(p);
      if (movidos.length) {
        git('add', 'specs/work_items.md', 'specs/work_items.done.md');
        git('commit', '-m', 'chore(specs): archiva Work Items integrados');
        hechos.push(`chore(specs): archiva ${movidos.length} Work Items integrados`);
      }
    }
    console.log(`${id}: integrado en ${integ}. Commits:\n${hechos.map((h) => `  - ${h}`).join('\n')}`);
    break;
  }

  default:
    fallo('Uso: node scripts/sdd.mjs <estado [--todos] | show <WI> | reglas | estado <WI> <nuevo> [--nota "texto"] | nota <WI> "texto" | archivar | rama <WI> | integrar <WI>>');
}
