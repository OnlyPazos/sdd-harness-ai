# SDD Harness — Spec Driven Development para cualquier agente de IA

Un pipeline de 8 roles (spec → plan → build → QA → git) más una base de
sistema de diseño reutilizable. Funciona con cualquier herramienta o modelo:
Claude Code, OpenCode, Codex, Cursor, GitHub Copilot, Gemini CLI, Aider o un
chat sin herramientas.

- **`AGENTS.md`** — punto de entrada para el agente: roles, flujo, estados y
  reglas comunes. Es lo que leen automáticamente la mayoría de herramientas.
- **`agents/<rol>.md`** — el prompt canónico de cada rol, con sus permisos
  declarados en el frontmatter. Es la única fuente de verdad.
- **`adapters/README.md`** — cómo conectarlo a cada herramienta y qué
  modelo usar por rol. Incluidos y listos: OpenCode (`opencode.json`) y
  Claude Code (`CLAUDE.md`, `.claude/`).

## Estructura

```
AGENTS.md
CLAUDE.md                     # → AGENTS.md
README.md
agents/
├── spec-writer.md
├── planner.md
├── builder.md
├── qa.md
├── git-manager.md
├── design-researcher.md
├── design-builder.md
└── design-extractor.md
adapters/README.md
opencode.json                 # adaptador OpenCode
install.sh, install.ps1       # instaladores (scripts/merge-*.mjs los apoyan)
.claude/
├── commands/sdd-<rol>.md     # adaptador Claude Code
├── hooks/sdd-timing.*        # registro de tiempos y su página
└── settings.json             # bloqueos globales (force push, rm -rf…) y hook de tiempos
specs/
├── templates/                # plantillas de stack: astro, expo, express, php
│                             # (+ design_system.md cuando lo importes)
└── (project_specs.md y work_items.md se generan aquí)
design-system/
├── README.md
├── tokens/                   # JSON: colors, typography, spacing, sizes, motion
├── research/                 # referencias de design-researcher (se genera)
└── components/button/        # ejemplo: Web Component vanilla
```

## Uso en un proyecto

1. Instala el harness en tu proyecto con el script (no sobrescribe nada):

   ```sh
   ./install.sh ../mi-proyecto [--tool claude|opencode|none] [--design]
   ```
   ```powershell
   .\install.ps1 ..\mi-proyecto [-Tool claude|opencode|none] [-Design]
   ```

   Copia `AGENTS.md`, `agents/`, `specs/templates/` y el adaptador elegido
   (por defecto Claude Code); con `--design`, también `design-system/` y su
   workflow. Si ya existe un `CLAUDE.md`, le añade `@AGENTS.md`; el resto de
   archivos que ya existan (p. ej. tu `AGENTS.md`) los lista para que los
   fusiones a mano.

   **Para actualizar** un proyecto a la última versión del harness, vuelve a
   ejecutarlo con `--update` (`-Update` en PowerShell):

   | Archivo | Qué hace `--update` |
   |---|---|
   | `agents/`, `.claude/commands/`, `.claude/hooks/` | Los sobrescribe (son del harness) |
   | `AGENTS.md` | Reemplaza solo el bloque entre `<!-- sdd:begin -->` y `<!-- sdd:end -->`; lo que escribas fuera se conserva |
   | `opencode.json` | Fusiona los agentes del harness y conserva tu configuración (modelos, proveedores, otros agentes). Requiere `node` |
   | `.claude/settings.json` | Añade los permisos y hooks del harness y conserva los tuyos. Requiere `node` |
   | `specs/templates/` | Si difieren, los lista para que los fusiones a mano |
   | `design-system/` | Nunca lo toca: es tuyo |

   Si tu `AGENTS.md` no tiene el bloque (instalaciones anteriores), fusiónalo
   a mano una vez incluyendo los marcadores, o usa `--force` (`-Force`):
   sobrescribe todo lo que `--update` no pueda actualizar, salvo
   `design-system/`, y guarda antes una copia `<archivo>.bak-<fecha>`.
   Revisa el resultado con `git diff`.
2. Invoca los roles en orden. Forma universal: `rol: <nombre> <args>`.

| Paso | Universal | OpenCode | Claude Code |
|---|---|---|---|
| Spec | `rol: spec-writer` | agente `spec-writer` (Tab) | `/sdd-spec-writer` |
| Plan | `rol: planner` | agente `planner` (Tab) | `/sdd-planner` |
| Rama | `rol: git-manager crear-rama WI-AC-001` | `@git-manager …` | `/sdd-git-manager …` |
| Implementar | `rol: builder WI-AC-001` | `@builder WI-AC-001` | `/sdd-builder WI-AC-001` |
| Verificar | `rol: qa WI-AC-001` | `@qa WI-AC-001` | `/sdd-qa WI-AC-001` |
| Integrar | `rol: git-manager merge WI-AC-001` | `@git-manager …` | `/sdd-git-manager …` |

Cada rol termina diciendo cuál es el siguiente. El estado de cada Work Item
(`pendiente → en-progreso → qa → verificado → integrado`) vive en
`specs/work_items.md`; las transiciones permitidas están en `AGENTS.md`.

> Ejecuta cada rol en una sesión o contexto limpio cuando puedas, sobre todo
> `qa`: si verifica en la misma conversación en la que se implementó, tiende
> a creerse al builder en lugar de comprobar.

## Los 8 roles

| Rol | Puede escribir | Ámbito |
|---|---|---|
| `spec-writer` | `specs/project_specs.md` | Spec con plantillas de stack + design_system.md |
| `planner` | `specs/work_items.md` | Descompone la spec en Work Items |
| `builder` | Código y tests de la app | Implementa UN Work Item |
| `qa` | Solo el estado del WI | Verifica UN Work Item y las reglas de stack |
| `git-manager` | Solo git + estado del WI | Ramas, merges, push |
| `design-researcher` | Solo `design-system/research/` | Investiga apps de referencia y propone direcciones |
| `design-builder` | Solo `design-system/` | Genera desde cero o itera tokens y componentes |
| `design-extractor` | Solo `design_system.md` | Documenta lo que existe realmente |

## Sistema de diseño

Base agnóstica de lenguaje: los tokens viven en JSON y los componentes
pueden estar en React, Vue, Svelte, PHP/Blade o web estándar. Flujo:

1. **Investiga referencias** (opcional): `rol: design-researcher <temática>`
   busca apps similares, analiza su paleta, tipografía y patrones, y te
   propone 2–3 direcciones justificadas en `design-system/research/references.md`.
   Tú eliges una; si ya tienes marca, sáltate este paso.
2. **Construye la base** en `design-system/` (este repo trae tokens de
   ejemplo y un Button en Web Components). Edítala a mano y usa
   `rol: design-builder <cambio>` para ayuda puntual, o
   `rol: design-builder genera el sistema de diseño desde cero` para que
   te entreviste y cree tokens y componentes base a partir de tu marca
   (y de la dirección elegida en el paso 1, si existe).
   Ese rol solo puede tocar `design-system/`.
3. **Cópiala a una app** si quieres iterar allí: `cp -r design-system/ mi-app/`.
4. **Extrae la documentación**: `rol: design-extractor` genera
   `design_system.md` leyendo el código real (no descripciones), con
   accesibilidad e inconsistencias detectadas. Ejecútalo en un contexto
   limpio: `design-builder` te ofrecerá lanzarlo como subagente si tu
   herramienta lo permite.
5. **Impórtala**: copia `design_system.md` a `specs/templates/` de la app.
   `spec-writer` lo cargará y no volverá a preguntar colores ni tipografía.

## Medir tiempos

Con Claude Code, cada vez que cierras una sesión un hook (`SessionEnd` en
`.claude/settings.json`) ejecuta `.claude/hooks/sdd-timing.mjs --log`. El
script lee los transcripts que Claude Code guarda en `~/.claude/projects/` y
reparte el tiempo activo de cada rol o petición en fases: investigar,
implementar, testear, git, ejecutar, responder y esperando (preguntas y
permisos). Deja dos archivos en `.sdd/`, que no se versiona:

- `timing.jsonl`: el registro, una línea por tarea. Conserva las sesiones
  aunque Claude Code borre sus transcripts (a los ~30 días).
- `timing.html`: ábrelo en el navegador. Tiempo por rol y fase, evolución
  del contexto y de los segundos por llamada, y el detalle de cada tarea.

La primera ejecución recupera también las sesiones anteriores que sigan
disponibles. A mano, desde la raíz del proyecto:

```sh
node .claude/hooks/sdd-timing.mjs --log            # actualiza el registro y la página
node .claude/hooks/sdd-timing.mjs                  # resumen en la terminal
node .claude/hooks/sdd-timing.mjs --session ultima # detalle: llamadas lentas, resultados grandes, relecturas
```

`s/llam` (segundos por llamada al modelo) y `ctx máx` (tokens de contexto)
indican si el modelo va más lento porque arrastra demasiado contexto.

## Añadir un stack

Crea `specs/templates/<stack>.md` siguiendo la estructura de las
existentes (dependencias mínimas, estructura de carpetas, reglas de código,
seguridad, testing, linting). `spec-writer` lista las plantillas
disponibles automáticamente.

## Licencia

[MIT](LICENSE).
