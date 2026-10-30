# Adaptadores: cómo usar los roles en cada herramienta

Los roles viven en `agents/<rol>.md` y las reglas comunes en `AGENTS.md`.
Nada de eso depende de una herramienta ni de un modelo. Un adaptador solo
hace dos cosas:

1. **Invocar** el rol (cargar `agents/<rol>.md` como instrucciones).
2. **Imponer** sus permisos, si la herramienta lo permite. Si no, el rol se
   los autoimpone (lo exige `AGENTS.md`), pero conviene revisar los diffs.

| Herramienta | Lee `AGENTS.md` | Invocar un rol | Impone permisos |
|---|---|---|---|
| OpenCode | Sí (`instructions`) | `@builder WI-AC-001` / Tab para primarios | Sí, por rol (`opencode.json`) |
| Claude Code | Vía `CLAUDE.md` | `/sdd-builder WI-AC-001` | Global (`.claude/settings.json`) + herramientas por subagente |
| Codex CLI | Sí, nativo | `rol: builder WI-AC-001` | Sandbox global |
| Cursor | Sí, nativo | `rol: builder WI-AC-001` o `@agents/builder.md` | No por rol |
| GitHub Copilot (agent) | Sí, nativo | `rol: builder WI-AC-001` o `#file:agents/builder.md` | No por rol |
| Gemini CLI | Configurable | `rol: builder WI-AC-001` o `@agents/builder.md` | Global |
| Aider | Con `--read` | `/read agents/builder.md` y luego la petición | No |
| Chat sin herramientas | — | Pega `AGENTS.md` + `agents/<rol>.md` | No (tú aplicas los cambios) |

`rol: <nombre> <argumentos>` es la forma universal: funciona en cualquier
herramienta que haya cargado `AGENTS.md`.

## Elegir modelo por rol

Ningún rol fija un modelo: usa el que tengas por defecto. Si tu herramienta
permite un modelo por rol, la recomendación orientativa es:

| Rol | Necesita | Por qué |
|---|---|---|
| spec-writer, qa | Alto razonamiento | Detectar ambigüedad y verificar con rigor es donde más falla un modelo flojo |
| builder, design-builder, orchestrator | Bueno en código | Volumen de edición, uso de herramientas |
| planner | Medio | Descompone una spec ya cerrada; la ambigüedad la resolvió spec-writer |
| design-researcher | Buen razonamiento + búsqueda web | Sintetizar referencias en direcciones justificadas |
| git-manager, design-extractor | Rápido/barato | Tareas mecánicas y acotadas |

Un modelo más pequeño tarda bastante menos por llamada, y en roles
mecánicos no se nota en el resultado.

- **OpenCode**: añade `"model": "<proveedor>/<modelo>"` al rol en `opencode.json`.
- **Claude Code**: ya vienen fijados: `/sdd-planner` con `sonnet`,
  `/sdd-git-manager` y el subagente `sdd-git-manager` con `haiku`, y
  `sdd-design-extractor` con `sonnet`. El resto usa el modelo de la
  sesión (`inherit`). Cámbialo con `model:` en el frontmatter de
  `.claude/commands/sdd-<rol>.md` o `.claude/agents/sdd-<rol>.md`.
- Resto: el modelo de la sesión.

## Detalle por herramienta

### OpenCode
Ya configurado en `opencode.json`. `spec-writer` y `planner` son agentes
primarios (cámbialos con Tab); el resto son subagentes (`@builder`,
`@qa`…). Los permisos de edición y bash se imponen por rol.

### Claude Code
`CLAUDE.md` importa `AGENTS.md`. Los comandos de `.claude/commands/` cargan
cada rol en la conversación principal, así los roles interactivos
(spec-writer, design-researcher, design-builder, git-manager) pueden
hacerte preguntas. `/sdd-design-researcher` preautoriza `WebSearch` y
`WebFetch` con `allowed-tools`.

`.claude/agents/` define builder, qa, git-manager y design-extractor como
subagentes, cada uno en un contexto limpio. Los usa `/sdd-orchestrator`, y
`/sdd-qa` y `/sdd-design-extractor` delegan siempre en el suyo. Los
subagentes `sdd-qa` y `sdd-git-manager` no tienen `Edit` ni `Write`:
solo cambian el Estado con `scripts/sdd.mjs`, así que no pueden tocar
código aunque se equivoquen.

`.claude/settings.json`:
- Preautoriza lo que los roles ejecutan a diario y no tiene riesgo (git
  local sin merge ni push, `scripts/sdd.mjs`, tests, lint y typecheck
  habituales), para que el pipeline no se pare a pedir permiso. Añade los
  comandos de test de tu stack si no están.
- Bloquea `push --force`, `reset --hard` y `rm -rf`, y pide confirmación
  (`ask`) para push y rebase. `git merge` no está en ninguna lista, así que
  también pide permiso, pero puedes preautorizarlo para que
  `/sdd-orchestrator` integre sin esperarte, añadiendo
  `{ "permissions": { "allow": ["Bash(git merge:*)"] } }` a tu
  `.claude/settings.local.json`. No lo pongas en `ask` en ningún archivo:
  Claude Code evalúa deny → ask → allow sin importar de qué archivo viene
  cada regla, y un `ask` anula cualquier `allow`. El merge a la rama
  principal sigue exigiendo tu confirmación por el prompt de `git-manager`,
  no por permisos.
- Hook `Notification`: aviso de escritorio cuando un rol espera un permiso
  o una respuesta (`SDD_NOTIFY=0` lo desactiva).
- Hook `SessionEnd`: registra los tiempos de cada sesión en `.sdd/` (ver
  «Medir tiempos» en el README).

Los límites por rol de los comandos que corren en la conversación principal
(p. ej. que builder no cambie de rama) los aplica el propio prompt.

### Codex CLI, Cursor, GitHub Copilot
Leen `AGENTS.md` de la raíz automáticamente. Escribe `rol: qa WI-AC-001`.
Si quieres atajos:
- Cursor: crea `.cursor/commands/sdd-<rol>.md` con el mismo cuerpo que los
  comandos de Claude Code (cambiando `@agents/...` por la referencia de Cursor).
- Copilot: crea `.github/prompts/sdd-<rol>.prompt.md` con
  `Sigue [agents/<rol>.md](../../agents/<rol>.md). Petición: ${input:peticion}`.

### Gemini CLI
Añade a `.gemini/settings.json`: `{ "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }`.

### Aider
`aider --read AGENTS.md --read agents/<rol>.md`. Aider no gestiona
permisos por rol: usa `--no-auto-commits` con `qa` y revisa cada diff.

## Añadir un adaptador nuevo
1. Haz que la herramienta cargue `AGENTS.md` como instrucciones de proyecto.
2. Crea un atajo por rol que inyecte `agents/<rol>.md` + la petición.
3. Traduce el bloque `permissions` del frontmatter a su sistema de permisos,
   si lo tiene. No copies el texto del prompt: referencia el archivo, para
   que haya una sola fuente de verdad.
