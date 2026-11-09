<!-- sdd:begin · bloque gestionado por el harness SDD: install --update lo reemplaza. Escribe tus reglas propias fuera de él. -->
<!-- prettier-ignore-start -->
# AGENTS.md — Pipeline SDD (Spec Driven Development)

Este archivo es el punto de entrada para **cualquier agente o modelo de IA**
que trabaje en este repositorio (Claude Code, OpenCode, Codex, Cursor,
GitHub Copilot, Gemini CLI, Aider, o un chat sin herramientas). No depende
de ningún proveedor, modelo ni sintaxis de invocación.

## Cómo funciona

El trabajo se divide en **roles**. Cada rol tiene un prompt canónico en
`agents/<rol>.md` con: su objetivo, qué puede leer/escribir, qué comandos
puede ejecutar, el formato de su salida y a qué rol entrega el trabajo.

Cuando el usuario pida actuar como un rol —por ejemplo `rol: qa WI-AC-001`,
`@qa`, `/sdd-qa`, "actúa como planner"— el agente DEBE:

1. Leer `agents/<rol>.md` completo antes de hacer nada más.
2. Seguirlo literalmente durante toda la tarea, incluidos los permisos.
3. No asumir las responsabilidades de otro rol: al terminar, indicar cuál
   es el siguiente rol y detenerse.

Si no se ha indicado ningún rol y la petición es de implementación, no
improvises: pregunta qué rol aplicar o sugiere el que corresponda según la
tabla.

## Roles

| Rol | Escribe | Ámbito | Interactivo |
|---|---|---|---|
| `spec-writer` | `specs/project_specs.md` | Define la spec con plantillas de stack + sistema de diseño | Sí |
| `planner` | `specs/work_items.md` | Descompone la spec en Work Items | Solo si hay ambigüedad |
| `builder` | Código de la app + estado en `work_items.md` | Implementa UN Work Item | No |
| `qa` | Solo el estado en `work_items.md` | Verifica UN Work Item | No |
| `git-manager` | Solo git + estado en `work_items.md` | Ramas, merges, push | Pide confirmación |
| `design-researcher` | Solo `design-system/research/` | Investiga apps de referencia y propone direcciones de diseño | Sí |
| `design-builder` | Solo `design-system/` | Genera e itera tokens y componentes | Sí |
| `design-extractor` | Solo `design_system.md` | Documenta el sistema de diseño real | No |
| `orchestrator` | Nada | Recorre los Work Items (en serie o en paralelo) lanzando builder y qa como subagentes; ramas, worktrees y merges con `sdd.mjs` (git-manager si fallan) | Solo para detenerse |

## Flujo

```
spec-writer → planner → [por cada Work Item: sdd.mjs rama → builder → qa → sdd.mjs integrar]
                                     (git-manager si rama o integrar fallan)

[design-researcher] → design-builder (arranque → iteración) → design-extractor → specs/templates/design_system.md → spec-writer
```

El bucle de Work Items se puede ejecutar a mano, rol a rol, o con
`orchestrator` si tu herramienta tiene subagentes: cada rol corre en un
contexto limpio y la conversación principal no acumula el de todos.

**Modo paralelo** (`orchestrator --paralelo N`): varios Work Items a la
vez, cada uno en su worktree (`.worktrees/<wi>`), mientras la raíz se
queda en la rama de integración:

```
sdd.mjs listos → por cada uno: sdd.mjs worktree → builder → sdd.mjs actualizar → qa → sdd.mjs integrar (de uno en uno)
```

`listos` solo propone Work Items que no tocan (campo `Toca` del plan) lo
mismo que otro en curso; los que no tienen `Toca` van de uno en uno.
`integrar` se niega si, desde el PASS de qa, la integración cambió
archivos que ese Work Item también toca: `actualizar` lo devuelve a `qa`
para verificar la combinación real. Si `actualizar` choca en código, deja
el merge abierto en el worktree y lo resuelve builder.

`design-researcher` es opcional (si ya hay marca o referencias claras, se
empieza en `design-builder`). `design-extractor` audita a `design-builder`
y, como `qa`, se ejecuta en un contexto limpio.

## Ciclo de vida de un Work Item

El campo `Estado` de cada Work Item en `specs/work_items.md` es la única
fuente de verdad del avance. Cada rol solo puede hacer SUS transiciones:

| Transición | Quién |
|---|---|
| `pendiente` → `en-progreso` | builder (al empezar) |
| `en-progreso` → `qa` | builder (al terminar) |
| `qa` → `verificado` | qa (PASS) |
| `qa` → `en-progreso` + nota del defecto | qa (FAIL) |
| `verificado` → `integrado` | git-manager (tras el merge) o `node scripts/sdd.mjs integrar` |
| `verificado` → `qa` | `node scripts/sdd.mjs actualizar` (la integración cambió archivos que el Work Item también toca) |

Las transiciones se hacen con `node scripts/sdd.mjs estado <WI> <nuevo>`,
que rechaza las que no están en la tabla, no editando el archivo a mano.

## Reglas comunes a todos los roles

- **Permisos**: el bloque `permissions` del frontmatter de cada rol es
  normativo. Si tu herramienta no puede imponerlo técnicamente, el agente
  debe autoimponérselo igual. Ante la duda, pregunta antes de actuar.
- **Fuente de verdad**: la spec (`specs/project_specs.md`) manda sobre
  cualquier interpretación propia. Si algo es ambiguo, se detiene y se
  devuelve a `spec-writer`; no se rellena el hueco inventando.
- **Evidencia, no afirmaciones**: no declares algo "hecho" o "verificado"
  sin el comando ejecutado y su salida.
- **Idioma**: responde en el idioma del usuario. Los identificadores
  (`WI-AC-001`, `AC-001`, `D-001`) y los nombres de rama no se traducen.
- **Seguridad**: nunca `git push --force`, `rm -rf`, ni borrar ramas o
  historial sin confirmación explícita del usuario en ese mismo turno.
- **Lee solo lo tuyo**: `specs/project_specs.md` y `specs/work_items.md`
  crecen hasta cientos de KB, y cargarlos enteros ralentiza cada paso. Usa
  `node scripts/sdd.mjs` (`estado`, `show <WI>`, `reglas`) y abre los
  archivos completos solo si su salida no basta.
- **Un comando por llamada**: sin encadenar con `&&`, `;` ni `cd … &&`
  (el directorio de trabajo ya es la raíz del proyecto) y sin variables de
  shell. Un comando compuesto no coincide con los permisos preautorizados
  y deja el pipeline parado esperando tu aprobación. Para mensajes de
  commit de varias líneas, usa varios `-m`. Excepciones, siempre con un
  solo comando detrás: en un monorepo cuyos subproyectos se ejecutan desde
  su carpeta, `cd <subcarpeta> && <comando>`; en modo paralelo,
  `cd .worktrees/<wi> && <comando>` (o `cd .worktrees/<wi>/<subcarpeta> && …`).
- **Modo paralelo**: si te lanzan con "WI-AC-XXX en .worktrees/wi-ac-xxx",
  ese worktree es tu raíz: todos tus comandos van con
  `cd .worktrees/wi-ac-xxx && …` y solo lees y editas archivos bajo esa
  carpeta. La raíz del repositorio es de otro: no la toques.
- **Rutas relativas a la raíz**: `node scripts/sdd.mjs …`, `git add app/x.ts`,
  `cd app && npx jest …`; nunca rutas absolutas (`node C:/…/scripts/sdd.mjs`),
  `git -C <ruta>`, `npm --prefix <ruta>` ni `composer --working-dir=…`.
  Los permisos preautorizados empiezan por el comando tal cual
  (`node scripts/sdd.mjs`, `git add`, `npm test`, `npx jest`): con otra
  forma no coinciden y el pipeline se para a pedir permiso. Para leer
  archivos usa la herramienta de lectura, no `cat`.

## Estructura del repositorio

```
AGENTS.md                 # este archivo (entrada universal)
CLAUDE.md                 # redirige a AGENTS.md (Claude Code)
agents/                   # prompts canónicos de cada rol, agnósticos de herramienta
adapters/README.md        # cómo conectar los roles a cada herramienta
opencode.json             # adaptador para OpenCode
.claude/commands/         # adaptador para Claude Code (/sdd-<rol>)
.claude/agents/           # subagentes de Claude Code (orchestrator, /sdd-qa)
scripts/sdd.mjs           # lectura acotada de specs/, cambios de Estado, rama, worktree e integrar
.worktrees/               # un worktree por Work Item en modo paralelo (sin versionar)
specs/
  templates/              # plantillas de stack (+ design_system.md importado)
  project_specs.md        # lo genera spec-writer
  work_items.md           # lo genera planner
  work_items.done.md      # Work Items integrados ya archivados
design-system/            # base de diseño reutilizable, agnóstica de lenguaje
```
<!-- prettier-ignore-end -->
<!-- sdd:end -->
