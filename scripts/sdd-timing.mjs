// Mide en qué se va el tiempo de las sesiones de Claude Code de un proyecto,
// a partir de los transcripts que guarda en ~/.claude/projects/. No necesita
// instrumentar nada: sirve también para sesiones pasadas.
//
// Uso: node scripts/sdd-timing.mjs [proyecto] [--last N] [--session <id>] [--json]
//   proyecto   ruta del proyecto analizado (por defecto: el directorio actual)
//   --last N   número de sesiones del resumen (por defecto: 10)
//   --session  detalle de una sesión (basta un prefijo del id, o "ultima")
//   --json     salida en JSON en lugar de tablas
//
// Cada tramo de tiempo se asigna a una fase:
//   investigar  Read/Grep/Glob/web, comandos de solo lectura, subagentes Explore
//   implementar Edit/Write, comandos que modifican archivos
//   testear     tests, lint, typecheck, build, navegador
//   git         comandos git
//   ejecutar    otros comandos (instalar dependencias, servidores…)
//   coordinar   TodoWrite, Skill, ToolSearch y similares
//   responder   el modelo redactando texto sin llamar a herramientas
//   esperando   preguntas al usuario y permisos (estimado)
// El tiempo del modelo que precede a una llamada cuenta en la fase de esa
// llamada. Las pausas entre turnos (el usuario leyendo o escribiendo) no
// cuentan. El tiempo de herramienta incluye las esperas de permiso, que el
// transcript no distingue: en herramientas que deberían ser instantáneas
// (Read, Edit…) lo que pase de PERMISO_S, y en el resto lo que pase de
// MAX_HERRAMIENTA_S, se cuenta como "esperando".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PERMISO_S = 10;
const MAX_HERRAMIENTA_S = 10 * 60;
// Un hueco del modelo mayor que esto es una sesión retomada, no trabajo.
const MAX_MODELO_S = 15 * 60;
// Roles que conversan con el usuario: sus respuestas no abren tarea nueva.
const INTERACTIVOS = new Set(['spec-writer', 'design-researcher', 'design-builder']);
const FASES = ['investigar', 'implementar', 'testear', 'git', 'ejecutar', 'coordinar', 'responder', 'esperando'];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] ?? '' : undefined;
};
const json = args.includes('--json') && args.splice(args.indexOf('--json'), 1);
const last = Number(opt('--last') ?? 10);
const sessionArg = opt('--session');
const project = resolve(args[0] ?? process.cwd());

const dir = join(homedir(), '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
if (!existsSync(dir)) {
  console.error(`No hay transcripts de Claude Code para ${project}\n(buscado en ${dir})`);
  process.exit(1);
}

// --- Clasificación -----------------------------------------------------------

const TEST_RE = /\b(test|tests|vitest|jest|playwright|cypress|phpunit|pest|pytest|tsc|eslint|stylelint|prettier|lint|typecheck|type-check|build|check|check-contrast)\b/;
const RUNNER_RE = /^(npm|pnpm|yarn|bun|npx|bunx|node|php|composer|vendor\/bin\/\S+|\.\/vendor\/bin\/\S+|vitest|jest|tsc|eslint|phpunit|pytest|playwright|astro|expo)\b/;
const LECTURA_RE = /^(ls|cat|head|tail|find|grep|rg|wc|sed -n|awk|tree|pwd|echo|stat|du|diff|file|which|type|less|Get-ChildItem|Get-Content|Select-String)\b/;
const ESCRITURA_RE = /^(mkdir|mv|cp|rm|touch|sed -i|tee|New-Item|Set-Content|Remove-Item|Copy-Item|Move-Item)\b|(^|[^2&])>\s*(?!\/dev\/null|&)\S/;

function faseBash(command = '') {
  // "cd ruta && git status" se clasifica por lo que va después del cd.
  const cmd = command.trim().replace(/^(cd\s+("[^"]*"|\S+)\s*(&&|;)\s*)+/, '');
  if (/^git\b/.test(cmd)) return 'git';
  if (RUNNER_RE.test(cmd) && TEST_RE.test(cmd)) return 'testear';
  if (ESCRITURA_RE.test(cmd)) return 'implementar';
  if (LECTURA_RE.test(cmd)) return 'investigar';
  return 'ejecutar';
}

function fase(tool) {
  const { name, input = {} } = tool;
  if (/^(Read|Grep|Glob|LS|WebSearch|WebFetch|NotebookRead)$/.test(name)) return 'investigar';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'implementar';
  if (/^(Bash|PowerShell)$/.test(name)) return faseBash(input.command);
  if (/^(Agent|Task)$/.test(name)) return /explore|plan/i.test(input.subagent_type ?? '') ? 'investigar' : 'ejecutar';
  if (name === 'AskUserQuestion') return 'esperando';
  if (/chrome|browser|playwright|puppeteer/i.test(name)) return 'testear';
  if (name.startsWith('mcp__')) return 'ejecutar';
  return 'coordinar';
}

const INSTANTANEA_RE = /^(Read|Grep|Glob|LS|Edit|Write|MultiEdit|NotebookEdit)$/;

function describir(tool) {
  const i = tool.input ?? {};
  const d = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.skill ?? '';
  return `${tool.name}: ${String(d).replace(/\s+/g, ' ')}`.slice(0, 90);
}

// --- Lectura de un transcript ------------------------------------------------

function textoDe(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function analizar(file) {
  const eventos = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  }).filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain && e.timestamp);

  const tareas = [];
  let tarea = null;
  const nuevaTarea = (rol, wi, t, peticion = '') => {
    tarea = { rol, wi, peticion, inicio: t, fases: {}, modelo: 0, herramientas: 0, llamadas: 0, ctx: [], salida: 0, lentas: [], resultados: [], lecturas: {} };
    for (const f of FASES) tarea.fases[f] = 0;
    tareas.push(tarea);
  };
  const sumar = (f, s, parte) => { tarea.fases[f] += s; if (parte) tarea[parte] += s; };

  const abiertas = new Map(); // tool_use_id -> { tool, fase, inicio }
  const vistos = new Set();   // ids de mensaje del modelo ya contados
  let prev = null;            // instante del último evento
  let modeloPendiente = 0;    // tiempo del modelo aún sin fase

  for (const e of eventos) {
    const t = Date.parse(e.timestamp);
    const texto = e.type === 'user' ? textoDe(e.message?.content) : '';
    const resultados = e.type === 'user' && Array.isArray(e.message?.content)
      ? e.message.content.filter((b) => b.type === 'tool_result') : [];
    const esUsuario = e.type === 'user' && !resultados.length && Boolean(texto);
    // Petición escrita por el usuario: un prompt normal o un comando que no
    // es de un rol (p. ej. "/goal Acaba el plan"); los /sdd-* llegan como rol.
    const comando = texto.match(/<command-name>\/([\w:-]+)<\/command-name>/)?.[1];
    const peticion = !esUsuario || e.isMeta || /^<(local-command|system-reminder|task-notification)/.test(texto.trim()) ? ''
      : comando ? (comando.startsWith('sdd-') ? '' : `/${comando} ${texto.match(/<command-args>([^<]*)/)?.[1] ?? ''}`.trim())
      : texto.trim();

    // El tiempo del modelo sin fase al llegar el usuario fue la respuesta final.
    if (esUsuario && modeloPendiente) { sumar('responder', modeloPendiente, 'modelo'); modeloPendiente = 0; }

    const rol = texto.match(/Adopta el rol \*\*([\w-]+)\*\*/)?.[1];
    if (rol) nuevaTarea(rol, texto.match(/\bWI-[A-Z0-9]+-\d+\b/)?.[0] ?? '', t);
    // Una petición nueva abre tarea, salvo respuestas cortas ("sí", "ok,
    // sigue") o la conversación de un rol interactivo.
    else if (peticion && (!tarea || (!INTERACTIVOS.has(tarea.rol) && peticion.length >= 40))) nuevaTarea('(sin rol)', '', t, peticion);
    else if (!tarea && e.type === 'assistant') nuevaTarea('(sin rol)', '', t);
    if (tarea && !tarea.peticion && peticion) tarea.peticion = peticion;

    if (prev !== null && t > prev) {
      const dt = (t - prev) / 1000;
      if (abiertas.size) {
        // Herramientas en paralelo: el tramo se reparte entre las abiertas.
        for (const a of abiertas.values()) a.dur += dt / abiertas.size;
      } else if (e.type === 'assistant') {
        modeloPendiente += Math.min(dt, MAX_MODELO_S);
      }
      // Sin herramientas abiertas y llega el usuario: estaba leyendo o
      // escribiendo; no cuenta.
    }

    if (e.type === 'assistant') {
      const m = e.message ?? {};
      if (m.id && !vistos.has(m.id) && m.usage) {
        vistos.add(m.id);
        const u = m.usage;
        tarea.llamadas++;
        tarea.ctx.push((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
        tarea.salida += u.output_tokens ?? 0;
      }
      for (const b of m.content ?? []) {
        if (b.type !== 'tool_use') continue;
        const f = fase(b);
        if (b.name === 'Skill' || /^(Agent|Task)$/.test(b.name)) {
          const r = String(b.input?.skill ?? '').match(/^sdd-([\w-]+)$/)?.[1];
          if (r) { if (modeloPendiente) sumar(f, modeloPendiente, 'modelo'); modeloPendiente = 0; nuevaTarea(r, String(b.input?.args ?? '').match(/\bWI-[A-Z0-9]+-\d+\b/)?.[0] ?? '', t); }
        }
        sumar(f, modeloPendiente, 'modelo');
        modeloPendiente = 0;
        abiertas.set(b.id, { tool: b, fase: f, dur: 0, tarea });
        if (b.name === 'Read' && b.input?.file_path) tarea.lecturas[b.input.file_path] = (tarea.lecturas[b.input.file_path] ?? 0) + 1;
      }
    }

    for (const r of resultados) {
      const a = abiertas.get(r.tool_use_id);
      if (!a) continue;
      abiertas.delete(r.tool_use_id);
      const espera = a.fase === 'esperando' ? 0
        : Math.max(0, a.dur - (INSTANTANEA_RE.test(a.tool.name) ? PERMISO_S : MAX_HERRAMIENTA_S));
      const tt = a.tarea;
      tt.fases[a.fase] += a.dur - espera;
      tt.fases.esperando += espera;
      tt.herramientas += a.dur - espera;
      tt.lentas.push({ s: a.dur, fase: a.fase, que: describir(a.tool) });
      const tam = typeof r.content === 'string' ? r.content.length : JSON.stringify(r.content ?? '').length;
      tt.resultados.push({ chars: tam, que: describir(a.tool) });
    }
    prev = t;
  }
  if (tarea && modeloPendiente) sumar('responder', modeloPendiente, 'modelo');

  for (const tt of tareas) {
    tt.activo = FASES.reduce((s, f) => s + tt.fases[f], 0);
    tt.lentas.sort((a, b) => b.s - a.s);
    tt.resultados.sort((a, b) => b.chars - a.chars);
  }
  return tareas.filter((tt) => tt.llamadas > 0);
}

// --- Salida ------------------------------------------------------------------

const dur = (s) => {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const fecha = (t) => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const resumen = (texto, n) => texto.replace(/\s+/g, ' ').slice(0, n);
const etiqueta = (tt) => (tt.rol === '(sin rol)' && tt.peticion ? `"${resumen(tt.peticion, 28)}"` : tt.rol);

function tabla(filas) {
  const anchos = filas[0].map((_, i) => Math.max(...filas.map((f) => String(f[i]).length)));
  return filas.map((f) => f.map((c, i) => (i ? String(c).padStart(anchos[i]) : String(c).padEnd(anchos[i]))).join('  ')).join('\n');
}

const sesiones = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ id: f.slice(0, -6), file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (sessionArg !== undefined) {
  const s = sessionArg === 'ultima' || sessionArg === '' ? sesiones[0] : sesiones.find((x) => x.id.startsWith(sessionArg));
  if (!s) { console.error(`No hay ninguna sesión que empiece por "${sessionArg}"`); process.exit(1); }
  const tareas = analizar(s.file);
  if (json) { console.log(JSON.stringify({ sesion: s.id, tareas }, null, 2)); process.exit(0); }

  console.log(`Sesión ${s.id}\n`);
  for (const tt of tareas) {
    const med = tt.ctx.length ? [...tt.ctx].sort((a, b) => a - b)[Math.floor(tt.ctx.length / 2)] : 0;
    console.log(`== ${tt.rol} ${tt.wi} ${tt.peticion ? `"${resumen(tt.peticion, 80)}"` : ''}  ·  ${fecha(tt.inicio)}  ·  activo ${dur(tt.activo)} (modelo ${dur(tt.modelo)}, herramientas ${dur(tt.herramientas)})`);
    console.log(`   ${tt.llamadas} llamadas al modelo · ${dur(tt.modelo / tt.llamadas)} por llamada · contexto ${k(tt.ctx[0] ?? 0)} → ${k(med)} (mediana) → ${k(Math.max(...tt.ctx))} (máx) · ${k(tt.salida)} tokens generados\n`);
    console.log(tabla([['fase', 'tiempo', '%'], ...FASES.filter((f) => tt.fases[f] >= 1).map((f) => [f, dur(tt.fases[f]), pct(tt.fases[f], tt.activo)])]).replace(/^/gm, '   '));
    console.log('\n   Llamadas más lentas:');
    console.log(tabla(tt.lentas.slice(0, 8).map((l) => [l.que, l.fase, dur(l.s)])).replace(/^/gm, '   '));
    console.log('\n   Resultados más grandes (inflan el contexto de todas las llamadas siguientes):');
    console.log(tabla(tt.resultados.slice(0, 5).map((r) => [r.que, `${k(r.chars)} chars`])).replace(/^/gm, '   '));
    const repes = Object.entries(tt.lecturas).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    if (repes.length) {
      console.log('\n   Archivos leídos más de una vez:');
      console.log(tabla(repes.slice(0, 5).map(([f, n]) => [f, `${n}×`])).replace(/^/gm, '   '));
    }
    console.log();
  }
} else {
  const filas = sesiones.slice(0, last).flatMap((s) => analizar(s.file).map((tt) => ({ sesion: s.id.slice(0, 8), ...tt })))
    .sort((a, b) => a.inicio - b.inicio);
  if (json) { console.log(JSON.stringify(filas, null, 2)); process.exit(0); }
  const cab = ['sesión', 'inicio', 'rol / petición', 'WI', 'activo', 'modelo', 's/llam', 'ctx máx', ...FASES];
  console.log(tabla([cab, ...filas.map((tt) => [
    tt.sesion, fecha(tt.inicio), etiqueta(tt), tt.wi || '-', dur(tt.activo), pct(tt.modelo, tt.activo),
    `${(tt.modelo / tt.llamadas).toFixed(1)}`, k(Math.max(...tt.ctx)),
    ...FASES.map((f) => pct(tt.fases[f], tt.activo)),
  ])]));
  console.log(`\nDetalle de una sesión: node scripts/sdd-timing.mjs ${args[0] ? `"${args[0]}" ` : ''}--session <id>`);
}
