// Acceso acotado a specs/ para los roles del pipeline: cada rol lee solo lo
// que necesita en vez de cargar project_specs.md y work_items.md enteros
// (en proyectos reales pasan de 100 KB y ralentizan cada llamada al modelo).
//
// Uso: node scripts/sdd.mjs <comando> [args]
//   estado [--todos]          resumen de Work Items: en curso, worktrees en
//                             paralelo, siguiente que se puede empezar y
//                             pendientes (los integrados, solo con --todos)
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
// Modo paralelo (varios Work Items a la vez, cada uno en su worktree; la
// raíz se queda en la rama de integración):
//   listos [--max N]          pendientes con dependencias integradas, sin
//                             reservar y que no tocan (campo "Toca") lo mismo
//                             que otro en curso: los que se pueden lanzar ya
//   worktree <WI> [--sin-deps]
//                             reserva el Work Item y abre su rama en
//                             .worktrees/<wi> (o la retoma si ya existe),
//                             copia los .env de la raíz e instala
//                             dependencias si faltan
//   actualizar <WI>           mergea la rama de integración en la del Work
//                             Item, en su worktree. Si estaba verificado y
//                             la integración cambió archivos que él también
//                             toca, vuelve a qa
//   liberar <WI>              quita la reserva y el worktree (si está limpio;
//                             la rama se conserva)
//
// rama, worktree, actualizar e integrar hacen el camino normal de
// git-manager sin un modelo de por medio. Lo que se salga de ese camino
// (sin rama de integración, cambios sin commitear, commits de otro Work
// Item, conflictos) lo rechazan con un mensaje para que lo resuelva
// git-manager. Las reservas viven en <git-common-dir>/sdd/, compartidas por
// todos los worktrees y sin versionar; los comandos que las tocan, y
// integrar, se serializan con un bloqueo.
//
// Los Work Items se buscan en work_items.md y en work_items.done.md.
// Sale con código 1 ante un error de uso o de datos.
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'specs', 'project_specs.md');
const PLAN_REL = 'specs/work_items.md';
const DONE_REL = 'specs/work_items.done.md';
const ESTADOS = ['pendiente', 'en-progreso', 'qa', 'verificado', 'integrado'];
const TRANSICIONES = {
  pendiente: ['en-progreso'],
  'en-progreso': ['qa'],
  qa: ['verificado', 'en-progreso'],
  // verificado → qa solo lo hace `actualizar`: la integración cambió
  // archivos que el Work Item también toca y el PASS ya no vale.
  verificado: ['integrado', 'qa'],
};
// Una entrada del Historial QA es un resumen: la evidencia completa va en el
// informe del rol, no en el plan, que todos los roles leen.
const MAX_NOTA = 500;
const MAX_BUFFER = 64 * 1024 * 1024;

const fallo = (msg) => {
  console.error(msg);
  process.exit(1);
};

const docDe = (path, texto) => ({ path, eol: texto.includes('\r\n') ? '\r\n' : '\n', lineas: texto.split(/\r?\n/) });
const leer = (path) => (existsSync(path) ? docDe(path, readFileSync(path, 'utf8')) : null);
const guardar = (doc) => {
  if (!doc.path) fallo('Error interno: no se puede guardar un documento leído de git.');
  writeFileSync(doc.path, doc.lineas.join(doc.eol));
};

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
// "Toca: app/notes/**, app/routes.ts" → ['app/notes/**', 'app/routes.ts']
const globs = (valor) => (valor ?? '').replace(/[`[\]]/g, '').split(',').map((g) => g.trim()).filter(Boolean);

const ejecutarGit = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
const gitEn = (cwd, ...args) => {
  const r = ejecutarGit(args, cwd);
  if (r.error) fallo(`No se pudo ejecutar git: ${r.error.message}`);
  if (r.status !== 0) fallo(`git ${args.join(' ')} falló:\n${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const git = (...args) => gitEn(ROOT, ...args);

// origen: {} → el checkout actual; { dir } → otro worktree; { ref } → lo
// commiteado en esa rama (sin hacer checkout).
const cargarPlan = (origen = {}) => {
  let plan, done;
  if (origen.ref) {
    const show = (rel) => {
      const r = ejecutarGit(['show', `${origen.ref}:${rel}`]);
      return r.status === 0 ? docDe(null, r.stdout) : null;
    };
    plan = show(PLAN_REL);
    done = show(DONE_REL);
    if (!plan) fallo(`No existe ${PLAN_REL} en ${origen.ref}. Lo genera el rol planner.`);
  } else {
    const base = origen.dir ?? ROOT;
    plan = leer(join(base, PLAN_REL));
    done = leer(join(base, DONE_REL));
    if (!plan) fallo(`No existe ${PLAN_REL}. Lo genera el rol planner.`);
  }
  const wis = [plan, done].filter(Boolean).flatMap((d) => secciones(d, /^## (WI-\S+)\s*$/, 2));
  for (const w of wis) {
    w.estado = (campo(w, 'Estado')?.valor ?? '').replace(/`/g, '');
    w.deps = ids(campo(w, 'Depende de')?.valor, RE_WI);
    w.acs = ids(campo(w, 'Acceptance Checks')?.valor, RE_AC);
    w.rama = campo(w, 'Rama sugerida')?.valor ?? '';
    w.toca = globs(campo(w, 'Toca')?.valor);
  }
  return { plan, done, wis, porId: new Map(wis.map((w) => [w.id, w])), dir: origen.dir ?? ROOT };
};
const buscar = (p, id) => p.porId.get(id) ?? fallo(`No existe ${id} en ${PLAN_REL} ni en ${DONE_REL}.`);

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
    path: join(p.dir, DONE_REL),
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

const lineasDe = (salida) => (salida ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const ramaActual = () => git('branch', '--show-current');
const existeRama = (rama) => git('branch', '--list', rama) !== '';
// Rutas con cambios sin commitear, incluidos archivos nuevos sin seguimiento.
const sinCommitear = (cwd = ROOT) => ejecutarGit(['status', '--porcelain', '--untracked-files=all'], cwd).stdout
  .split('\n').filter((l) => l.trim())
  .map((l) => l.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, ''));
const ramaIntegracion = () => {
  const ramas = lineasDe(git('branch', '--list', 'integration/*')).map((l) => l.replace(/^[*+]\s*/, ''));
  if (ramas.length === 1) return ramas[0];
  fallo(ramas.length
    ? `Hay varias ramas de integración (${ramas.join(', ')}): decide cuál con git-manager.`
    : 'No existe ninguna rama integration/<proyecto>: créala con git-manager (solo la primera vez).');
};
const esAncestro = (a, b) => ejecutarGit(['merge-base', '--is-ancestor', a, b]).status === 0;
const PLAN_O_DONE = /^specs\/work_items(\.done)?\.md$/;
// Archivos (sin contar el plan) que cambiaron en `hasta` desde `desde`.
const cambiados = (desde, hasta) => lineasDe(git('diff', '--name-only', `${desde}..${hasta}`)).filter((f) => !PLAN_O_DONE.test(f));
// Archivos que tocaron a la vez la integración y la rama desde que se separaron.
const solape = (integ, rama) => {
  const base = git('merge-base', integ, rama);
  const deRama = new Set(cambiados(base, rama));
  return cambiados(base, integ).filter((f) => deRama.has(f));
};
const resumen = (lista, max = 5) => lista.slice(0, max).join(', ') + (lista.length > max ? ` y ${lista.length - max} más` : '');

// ---------- Worktrees y reservas (modo paralelo) ----------

const norm = (p) => {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const mismaRuta = (a, b) => norm(a) === norm(b);
const worktrees = () => {
  const out = [];
  let act = null;
  for (const l of git('worktree', 'list', '--porcelain').split('\n').map((x) => x.trim())) {
    if (l.startsWith('worktree ')) out.push((act = { path: resolve(l.slice(9)), rama: null }));
    else if (l.startsWith('branch ') && act) act.rama = l.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
};
const principal = () => worktrees()[0].path;
const worktreeDe = (rama) => worktrees().find((w) => w.rama === rama) ?? null;
const rutaWorktree = (id) => join(principal(), '.worktrees', id.toLowerCase());
const rel = (p) => relative(principal(), p).replace(/\\/g, '/') || '.';

// Fuera de un repo git (p. ej. planner antes del primer commit) no hay reservas.
const dirSdd = () => {
  const r = ejecutarGit(['rev-parse', '--git-common-dir']);
  return r.status === 0 ? join(resolve(ROOT, r.stdout.trim()), 'sdd') : null;
};
const leerReservas = () => {
  const d = dirSdd();
  const f = d && join(d, 'reservas.json');
  if (!f || !existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    fallo(`${f} no es JSON válido: revísalo o bórralo (solo guarda qué Work Items están en un worktree).`);
  }
};
const guardarReservas = (r) => {
  const d = dirSdd() ?? fallo('No es un repositorio git.');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'reservas.json'), `${JSON.stringify(r, null, 2)}\n`);
};

// Bloqueo entre procesos: mkdir es atómico. Se libera al salir, también si
// un comando termina con fallo() a mitad.
let bloqueo = null;
process.on('exit', () => {
  if (bloqueo) try { rmdirSync(bloqueo); } catch { /* ya no existe */ }
});
const conBloqueo = (fn) => {
  const d = dirSdd() ?? fallo('No es un repositorio git.');
  const lock = join(d, 'lock');
  mkdirSync(d, { recursive: true });
  const limite = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // Un bloqueo de más de 10 minutos es de un proceso que murió.
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) {
          rmdirSync(lock);
          continue;
        }
      } catch { continue; }
      if (Date.now() > limite) fallo(`Otro sdd.mjs tiene el bloqueo (${lock}) desde hace más de 2 minutos. Si no hay ninguno en marcha, borra esa carpeta.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  bloqueo = lock;
  try {
    return fn();
  } finally {
    rmdirSync(lock);
    bloqueo = null;
  }
};

// Solapan si el prefijo literal (antes del primer comodín) de uno es
// prefijo del otro. Aproximado y conservador: app/** solapa con todo app/.
const prefijo = (g) => g.replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?[{]/)[0];
const solapan = (a, b) => a.flatMap((x) => b.filter((y) => {
  const p = prefijo(x);
  const q = prefijo(y);
  return p.startsWith(q) || q.startsWith(p);
}).map((y) => (x === y ? x : `${x} ~ ${y}`)));

// Carpetas donde puede haber dependencias o .env: la raíz y el primer nivel
// (monorepos con app/, backend/…).
const carpetasProyecto = (raiz) => ['', ...readdirSync(raiz, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'vendor'].includes(d.name))
  .map((d) => d.name)];
const INSTALADORES = [
  ['package-lock.json', 'node_modules', 'npm ci'],
  ['pnpm-lock.yaml', 'node_modules', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'node_modules', 'yarn install --frozen-lockfile'],
  ['composer.lock', 'vendor', 'composer install --no-interaction'],
];
const instalarDeps = (wt) => {
  const hechos = [];
  for (const sub of carpetasProyecto(wt)) {
    const dir = join(wt, sub);
    const inst = INSTALADORES.find(([lock]) => existsSync(join(dir, lock)));
    if (!inst || existsSync(join(dir, inst[1]))) continue;
    const donde = sub || '.';
    const r = spawnSync(inst[2], { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    if (r.status !== 0) {
      const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
      fallo(`Worktree listo, pero falló \`${inst[2]}\` en ${rel(dir)}:\n${salida}\nInstálalo a mano o repite \`node scripts/sdd.mjs worktree <WI>\` (solo instala lo que falta).`);
    }
    hechos.push(`${inst[2]} en ${donde}`);
  }
  return hechos;
};
// Los .env no se versionan: sin copiarlos, los tests del worktree no arrancan.
const copiarEnv = (origen, wt) => {
  const copiados = [];
  for (const sub of carpetasProyecto(origen)) {
    const dir = join(origen, sub);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !/^\.env(\..+)?$/.test(f.name)) continue;
      const destino = join(wt, sub, f.name);
      if (existsSync(destino) || !existsSync(join(wt, sub))) continue;
      copyFileSync(join(dir, f.name), destino);
      copiados.push(sub ? `${sub}/${f.name}` : f.name);
    }
  }
  return copiados;
};
// .worktrees/ no debe aparecer como cambio sin commitear en la raíz. Se
// excluye en .git/info/exclude, que no se versiona.
const excluirWorktrees = () => {
  const f = join(resolve(ROOT, git('rev-parse', '--git-common-dir')), 'info', 'exclude');
  const actual = existsSync(f) ? readFileSync(f, 'utf8') : '';
  if (actual.split(/\r?\n/).some((l) => l.trim() === '.worktrees/')) return;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${actual}${actual && !actual.endsWith('\n') ? '\n' : ''}.worktrees/\n`);
};
// Commitea en `dir` el cambio de Estado que dejó un rol sin commitear (qa no
// puede commitear). Devuelve el mensaje o null si no había nada.
const commitearEstado = (dir, id, estado) => {
  if (!sinCommitear(dir).includes(PLAN_REL)) return null;
  const msg = estado === 'verificado' ? `chore(${id}): verificado por QA` : `chore(${id}): estado ${estado}`;
  gitEn(dir, 'add', PLAN_REL);
  gitEn(dir, 'commit', '-m', msg);
  return msg;
};
const quitarWorktree = (wt) => {
  const r = ejecutarGit(['worktree', 'remove', wt]);
  return r.status === 0 ? null : (r.stderr || r.stdout).trim();
};

// ---------- Comandos ----------

const [cmd, ...args] = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};

switch (cmd) {
  case 'estado': {
    const nota = opt('--nota');
    const todos = flag('--todos');
    const p = cargarPlan();
    if (args[0]) {
      const [id, nuevo] = args;
      const w = buscar(p, id);
      const antes = w.estado;
      cambiarEstado(w, nuevo, nota);
      console.log(`${id}: ${antes} → ${nuevo}${nota ? ' (nota añadida al Historial QA)' : ''}`);
      break;
    }
    const reservas = leerReservas();
    // Los que están en un worktree se listan aparte: aquí siguen en pendiente.
    const enWorktree = (w) => Boolean(reservas[w.id]);
    const ocupados = p.wis.filter(enWorktree);
    const listos = (w) => w.deps.every((d) => p.porId.get(d)?.estado === 'integrado')
      && !ocupados.some((o) => solapan(w.toca, o.toca).length);
    const fila = (w) => `  ${w.id.padEnd(14)} ${w.estado.padEnd(11)} ${w.deps.length ? `depende de ${w.deps.map((d) => `${d} (${p.porId.get(d)?.estado ?? '¿no existe?'})`).join(', ')}` : ''}`;
    const enCurso = p.wis.filter((w) => ABIERTOS.includes(w.estado) && !enWorktree(w));
    const pendientes = p.wis.filter((w) => w.estado === 'pendiente' && !enWorktree(w));
    const integrados = p.wis.filter((w) => w.estado === 'integrado');
    const otros = p.wis.filter((w) => !ESTADOS.includes(w.estado));
    console.log(`${p.wis.length} Work Items: ${integrados.length} integrados, ${enCurso.length + ocupados.length} en curso, ${pendientes.length} pendientes.`);
    if (enCurso.length) console.log(`En curso:\n${enCurso.map(fila).join('\n')}`);
    const reservados = Object.entries(reservas);
    if (reservados.length) {
      // El Estado real de cada uno está en su worktree, no en esta rama.
      const raiz = principal();
      console.log(`En worktrees (modo paralelo):\n${reservados.map(([id, r]) => {
        const dir = join(raiz, r.worktree);
        const est = existsSync(dir) ? (cargarPlan({ dir }).porId.get(id)?.estado ?? '¿?') : 'worktree borrado: node scripts/sdd.mjs liberar ' + id;
        return `  ${id.padEnd(14)} ${est.padEnd(11)} ${r.worktree} (hueco ${r.hueco})`;
      }).join('\n')}`);
    }
    const siguiente = pendientes.find(listos);
    console.log(siguiente ? `Siguiente que se puede empezar: ${siguiente.id} (${siguiente.rama})` : 'Ningún pendiente libre tiene todas sus dependencias integradas.');
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
    const r = leerReservas()[id];
    if (r) console.log(`===== Modo paralelo =====\nWorktree: ${r.worktree} · hueco ${r.hueco} (puerto/BD de tests: base + ${r.hueco})\n`);
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
    const reservas = Object.keys(leerReservas());
    if (reservas.length) fallo(`Hay Work Items en worktrees (${reservas.join(', ')}): archivar movería bloques que sus ramas también tocan. Espera a integrarlos.`);
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
    const wt = worktreeDe(rama);
    if (wt && !mismaRuta(wt.path, ROOT)) fallo(`${rama} está abierta en el worktree ${rel(wt.path)}: ${id} va en modo paralelo, trabaja ahí.`);
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

  case 'listos': {
    const max = Number(opt('--max') ?? Infinity);
    if (!(max > 0)) fallo('Uso: node scripts/sdd.mjs listos [--max N]');
    const integ = ramaIntegracion();
    const p = cargarPlan({ ref: integ });
    const reservas = leerReservas();
    // Lo que ya está en marcha ocupa sus archivos.
    const ocupados = Object.keys(reservas).map((id) => p.porId.get(id)).filter(Boolean);
    const elegidos = [];
    const esperan = [];
    for (const w of p.wis) {
      if (w.estado !== 'pendiente' || reservas[w.id]) continue;
      if (!w.deps.every((d) => p.porId.get(d)?.estado === 'integrado')) continue;
      const choque = [...ocupados, ...elegidos].map((o) => [o, solapan(w.toca, o.toca)]).find(([, s]) => s.length);
      if (choque) {
        esperan.push(`  ${w.id.padEnd(14)} toca ${resumen(choque[1], 3)} como ${choque[0].id}`);
        continue;
      }
      if (elegidos.length < max) elegidos.push(w);
    }
    console.log(elegidos.length
      ? `Listos para lanzar en paralelo (${elegidos.length}):\n${elegidos.map((w) => `  ${w.id.padEnd(14)} ${w.rama}${existeRama(w.rama) ? ' (rama ya existe: se retoma)' : ''}${w.toca.length ? '' : ' (sin "Toca": no se comprueba solape)'}`).join('\n')}`
      : 'Ningún pendiente libre tiene todas sus dependencias integradas.');
    if (ocupados.length) console.log(`En worktrees: ${ocupados.map((w) => w.id).join(', ')}`);
    if (esperan.length) console.log(`Esperan a que se integre otro (mismos archivos):\n${esperan.join('\n')}`);
    break;
  }

  case 'worktree': {
    const sinDeps = flag('--sin-deps');
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs worktree <WI> [--sin-deps]');
    const info = conBloqueo(() => {
      const integ = ramaIntegracion();
      const p = cargarPlan({ ref: integ });
      const w = buscar(p, id);
      const rama = w.rama || fallo(`${id} no tiene "Rama sugerida".`);
      const reservas = leerReservas();
      const avisos = [];
      let wt = worktreeDe(rama);
      let accion = 'retomado';
      if (!wt) {
        const ruta = rutaWorktree(id);
        if (existsSync(ruta)) fallo(`${rel(ruta)} existe pero no es un worktree de ${rama}: revísalo con git-manager.`);
        excluirWorktrees();
        if (existeRama(rama)) {
          git('worktree', 'add', ruta, rama);
          accion = `abierto sobre ${rama}, que ya existía`;
        } else {
          if (w.estado !== 'pendiente') fallo(`${id} está en "${w.estado}" en ${integ} y no existe su rama ${rama}: revísalo con git-manager.`);
          const faltan = w.deps.filter((d) => p.porId.get(d)?.estado !== 'integrado');
          if (faltan.length) fallo(`${id} depende de Work Items sin integrar: ${faltan.map((d) => `${d} (${p.porId.get(d)?.estado ?? 'no existe'})`).join(', ')}.`);
          for (const otro of Object.keys(reservas)) {
            const o = p.porId.get(otro);
            const s = o ? solapan(w.toca, o.toca) : [];
            if (s.length) avisos.push(`AVISO: toca ${resumen(s, 3)}, igual que ${otro} (en curso): probable conflicto al integrar.`);
          }
          git('worktree', 'add', '-b', rama, ruta, integ);
          accion = `creada ${rama} desde ${integ}`;
        }
        wt = { path: ruta, rama };
      } else if (mismaRuta(wt.path, principal())) {
        fallo(`${rama} está abierta en la raíz del repositorio (modo serie). Vuelve la raíz a la rama de integración con git-manager antes de pasar ${id} a un worktree.`);
      }
      if (!reservas[id]) {
        const usados = new Set(Object.values(reservas).map((r) => r.hueco));
        let hueco = 1;
        while (usados.has(hueco)) hueco++;
        reservas[id] = { rama, worktree: rel(wt.path), hueco, desde: new Date().toISOString() };
        guardarReservas(reservas);
      }
      return { ...reservas[id], path: wt.path, accion, avisos };
    });
    const env = copiarEnv(principal(), info.path);
    const deps = sinDeps ? [] : instalarDeps(info.path);
    console.log(`${id}: worktree ${info.worktree} (${info.accion}) · hueco ${info.hueco}.`);
    if (env.length) console.log(`Copiados de la raíz: ${env.join(', ')}`);
    if (deps.length) console.log(`Dependencias: ${deps.join('; ')}`);
    for (const a of info.avisos) console.log(a);
    console.log(`Siguiente rol: builder con "${id} en ${info.worktree}".`);
    break;
  }

  case 'actualizar': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs actualizar <WI>');
    conBloqueo(() => {
      const integ = ramaIntegracion();
      const rama = buscar(cargarPlan({ ref: integ }), id).rama || fallo(`${id} no tiene "Rama sugerida".`);
      if (!existeRama(rama)) fallo(`No existe la rama ${rama}.`);
      const wt = worktreeDe(rama) ?? fallo(`${rama} no está abierta en ningún worktree: ábrela con node scripts/sdd.mjs worktree ${id}.`);
      if (esAncestro(integ, rama)) {
        console.log(`${id}: ${rama} ya está al día con ${integ}.`);
        return;
      }
      const ajenos = sinCommitear(wt.path).filter((f) => f !== PLAN_REL);
      if (ajenos.length) fallo(`${rel(wt.path)} tiene cambios sin commitear fuera de ${PLAN_REL} (${resumen(ajenos)}): el builder no terminó; revísalo con git-manager.`);
      const hechos = [];
      const previo = commitearEstado(wt.path, id, buscar(cargarPlan({ dir: wt.path }), id).estado);
      if (previo) hechos.push(previo);
      const comunes = solape(integ, rama);
      const m = ejecutarGit(['merge', '--no-ff', integ, '-m', `merge(${id}): actualiza con ${integ}`], wt.path);
      if (m.status !== 0) {
        const conflictos = lineasDe(ejecutarGit(['diff', '--name-only', '--diff-filter=U'], wt.path).stdout);
        if (conflictos.length) {
          ejecutarGit(['merge', '--abort'], wt.path);
          fallo(`CONFLICTO al mergear ${integ} en ${rama}: ${conflictos.join(', ')}. Merge abortado; resuélvelo con git-manager en ${rel(wt.path)}.`);
        }
        fallo(`git merge falló:\n${(m.stderr || m.stdout).trim()}`);
      }
      hechos.push(`merge(${id}): actualiza con ${integ}`);
      const w = buscar(cargarPlan({ dir: wt.path }), id);
      if (w.estado === 'verificado' && comunes.length) {
        cambiarEstado(w, 'qa', `Actualizado con ${integ}, que también cambió ${resumen(comunes, 3)}: el PASS anterior no cubre la combinación; vuelve a qa.`);
        gitEn(wt.path, 'add', PLAN_REL);
        gitEn(wt.path, 'commit', '-m', `chore(${id}): vuelve a qa tras actualizar`);
        hechos.push(`chore(${id}): vuelve a qa tras actualizar`);
      }
      console.log(`${id}: ${rama} actualizada con ${integ}${comunes.length ? ` (archivos tocados por ambos: ${resumen(comunes)})` : ''}. Estado: ${buscar(cargarPlan({ dir: wt.path }), id).estado}. Commits:\n${hechos.map((h) => `  - ${h}`).join('\n')}`);
    });
    break;
  }

  case 'liberar': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs liberar <WI>');
    conBloqueo(() => {
      const reservas = leerReservas();
      const r = reservas[id];
      const wt = r ? worktrees().find((x) => x.rama === r.rama && !mismaRuta(x.path, principal())) : null;
      if (!r && !wt) fallo(`${id} no tiene reserva ni worktree.`);
      let detalle = 'sin worktree';
      if (wt) {
        const err = quitarWorktree(wt.path);
        detalle = err ? `el worktree ${rel(wt.path)} se queda (${err.split('\n')[0]})` : `worktree ${rel(wt.path)} eliminado`;
      }
      delete reservas[id];
      guardarReservas(reservas);
      console.log(`${id}: reserva liberada, ${detalle}. La rama ${r.rama} se conserva.`);
    });
    break;
  }

  case 'integrar': {
    const [id] = args;
    if (!id) fallo('Uso: node scripts/sdd.mjs integrar <WI>');
    conBloqueo(() => {
      const raiz = principal();
      if (!mismaRuta(ROOT, raiz)) fallo(`Ejecuta integrar desde la raíz del repositorio (${raiz}), no desde un worktree.`);
      const integ = ramaIntegracion();
      const rama = buscar(cargarPlan(), id).rama || fallo(`${id} no tiene "Rama sugerida".`);
      if (!existeRama(rama)) fallo(`No existe la rama ${rama}.`);
      const hechos = [];
      // Modo paralelo: la rama vive en su worktree y la raíz en integración.
      const wt = worktreeDe(rama);
      const paralelo = wt && !mismaRuta(wt.path, ROOT);
      const dir = paralelo ? wt.path : ROOT;
      if (paralelo) {
        if (ramaActual() !== integ) {
          const sucios = sinCommitear();
          if (sucios.length) fallo(`La raíz está en ${ramaActual()} con cambios sin commitear (${resumen(sucios)}): revísalo con git-manager.`);
          git('checkout', integ);
        }
      } else if (ramaActual() !== rama) {
        const sucios = sinCommitear();
        if (sucios.length) fallo(`Estás en ${ramaActual()} con cambios sin commitear (${resumen(sucios)}): revísalo con git-manager.`);
        git('checkout', rama);
      }
      const ajenos = sinCommitear(dir).filter((f) => f !== PLAN_REL);
      if (ajenos.length) fallo(`${rama} tiene cambios sin commitear fuera de ${PLAN_REL} (${resumen(ajenos)}): revísalo con git-manager.`);
      const w = buscar(cargarPlan({ dir }), id);
      if (w.estado !== 'verificado') fallo(`${id} está en "${w.estado}", no en "verificado": no se integra sin el PASS de qa.`);
      const previo = commitearEstado(dir, id, 'verificado');
      if (previo) hechos.push(`${previo} (en ${rama})`);
      const commits = lineasDe(git('log', '--format=%s', `${integ}..${rama}`));
      if (!commits.length) fallo(`${rama} no tiene commits que no estén ya en ${integ}.`);
      const otros = commits.filter((c) => !c.includes(id));
      if (otros.length) fallo(`${rama} tiene commits que no mencionan ${id}; revísalo con git-manager antes de integrar:\n${otros.map((c) => `  ${c}`).join('\n')}`);
      // Si otro Work Item se integró después del PASS y tocó lo mismo, qa
      // verificó una combinación que ya no es la real.
      if (!esAncestro(integ, rama)) {
        const comunes = solape(integ, rama);
        if (comunes.length) fallo(`${integ} ha cambiado ${resumen(comunes)} desde que se separó ${rama}, y ${id} también los toca: el PASS de qa no cubre la combinación. Ejecuta node scripts/sdd.mjs actualizar ${id} (lo devuelve a qa) y repite qa.`);
      }
      // Descripción del merge: el primer commit de trabajo de la rama.
      const trabajo = [...commits].reverse().find((c) => !/^(chore|merge)\b/.test(c));
      const desc = trabajo ? trabajo.replace(/^[^:]*:\s*/, '') : w.acs.join(', ') || id;
      if (ramaActual() !== integ) git('checkout', integ);
      const m = ejecutarGit(['merge', '--no-ff', rama, '-m', `merge(${id}): ${desc}`]);
      if (m.status !== 0) {
        const conflictos = lineasDe(ejecutarGit(['diff', '--name-only', '--diff-filter=U']).stdout);
        if (conflictos.length) {
          ejecutarGit(['merge', '--abort']);
          fallo(`CONFLICTO al mergear ${rama} en ${integ}: ${conflictos.join(', ')}. Merge abortado, sigues en ${integ}; resuélvelo con git-manager${paralelo ? ` o con node scripts/sdd.mjs actualizar ${id} y repitiendo qa` : ''}.`);
        }
        fallo(`git merge falló:\n${(m.stderr || m.stdout).trim()}`);
      }
      hechos.push(`merge(${id}): ${desc}`);
      cambiarEstado(buscar(cargarPlan(), id), 'integrado');
      git('add', PLAN_REL);
      git('commit', '-m', `chore(${id}): integrado`);
      hechos.push(`chore(${id}): integrado`);
      const reservas = leerReservas();
      if (reservas[id]) {
        delete reservas[id];
        guardarReservas(reservas);
      }
      if (paralelo) {
        const err = quitarWorktree(wt.path);
        hechos.push(err ? `el worktree ${rel(wt.path)} se queda: ${err.split('\n')[0]}` : `worktree ${rel(wt.path)} eliminado`);
      }
      const p = cargarPlan();
      const abiertos = [...new Set([...p.wis.filter((x) => ABIERTOS.includes(x.estado)).map((x) => x.id), ...Object.keys(reservas)])];
      if (abiertos.length) {
        hechos.push(`sin archivar: siguen abiertos ${abiertos.join(', ')}`);
      } else {
        const movidos = archivar(p);
        if (movidos.length) {
          git('add', PLAN_REL, DONE_REL);
          git('commit', '-m', 'chore(specs): archiva Work Items integrados');
          hechos.push(`chore(specs): archiva ${movidos.length} Work Items integrados`);
        }
      }
      console.log(`${id}: integrado en ${integ}. Commits:\n${hechos.map((h) => `  - ${h}`).join('\n')}`);
    });
    break;
  }

  default:
    fallo('Uso: node scripts/sdd.mjs <estado [--todos] | show <WI> | reglas | estado <WI> <nuevo> [--nota "texto"] | nota <WI> "texto" | archivar | rama <WI> | integrar <WI> | listos [--max N] | worktree <WI> [--sin-deps] | actualizar <WI> | liberar <WI>>');
}
