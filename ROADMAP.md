# Roadmap del harness

Mejoras pendientes, en orden de prioridad. 1 y 2 van juntas: el frontmatter
legible por máquina es la base de ambas.

## 1. Imponer permisos por rol en Claude Code
Hoy los permisos de cada rol solo están en el prompt: `.claude/settings.json`
es global, así que nada impide que `qa` edite código o que `builder` haga
`git checkout` (OpenCode sí los aplica por agente).

- Hook `PreToolUse` (`.claude/hooks/sdd-guard.mjs`) que detecte el rol activo
  como hace `sdd-timing.mjs` (`Adopta el rol **x**`) y bloquee `Edit`/`Write`
  sobre `never_edit` y `Bash` en `deny` según el frontmatter del rol.
- Requiere pasar `writes`, `never_edit` y `permissions.commands` del
  frontmatter a globs y patrones concretos (hoy hay prosa como "código y
  tests de la app" o "tests del proyecto (npm test…)").

## 2. Una sola fuente de permisos; adaptadores generados
Los permisos están triplicados (frontmatter, `opencode.json`,
`.claude/settings.json`) y ya divergen: `builder` prohíbe "crear o borrar
ramas" en su frontmatter, pero `opencode.json` no tiene `git branch*` en deny.

- `scripts/build-adapters.mjs` que genere `opencode.json` y
  `.claude/commands/sdd-*.md` desde `agents/*.md`.
- Modo `--check` en CI, como `build-tokens.mjs --check`.

## 3. Validador de specs (`scripts/sdd-check.mjs`)
Comprobaciones deterministas sobre `specs/`:

- IDs de AC, WI y D sin duplicados.
- Todo AC no `[retirado]` cubierto por al menos un Work Item.
- `Depende de` apunta a Work Items existentes y sin ciclos.
- Estados válidos; ningún Work Item en curso sobre un AC `[bloqueado]`.

Lo ejecutan `planner` al terminar, `qa` antes del veredicto y el CI. Encaja
como subcomando `check` de `scripts/sdd.mjs`, que ya parsea ambos archivos.

## 4. Comando `/sdd-status` (o `/sdd-next`)
`node scripts/sdd.mjs estado` ya da el estado y el siguiente Work Item.
Falta el comando que lo envuelva y diga también qué rol toca (según la rama
actual) y avise de Work Items con varios FAIL de QA.

## 5. ~~QA y design-extractor en contexto limpio~~ (hecho)
Subagentes en `.claude/agents/`; `/sdd-qa` y `/sdd-design-extractor`
delegan en ellos.

## 6. Huecos en los prompts
- **Cambios de spec tras integrar**: `planner` solo añade Work Items. Falta
  la regla para un AC `[retirado]` o modificado cuyo Work Item ya está
  `integrado` (Work Item de corrección, marcar obsoleto…).
- ~~**`BLOQUEADO` de QA** no deja rastro~~ (hecho: `sdd.mjs nota`).
- **Migrar specs existentes** que copian las plantillas en "Reglas base de
  stack" al formato con referencias (en kanban-board son ~125 KB).
- **`sdd-timing`** no ve el trabajo de los subagentes (van en otro
  transcript): el orquestador aparece como una sola tarea.
- **Push**: ningún paso del flujo lo pide. Definir cuándo toca (tras cada
  merge a integración o al cerrar el proyecto).

## 7. Secundario
- CI del propio harness: frontmatter válido, adaptadores sincronizados,
  instaladores.
- Proyecto de ejemplo en `examples/` (spec y Work Items rellenos) como
  documentación y banco de pruebas de los roles.
- Más plantillas de stack (Next.js, FastAPI…).
