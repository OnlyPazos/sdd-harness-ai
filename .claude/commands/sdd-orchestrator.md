---
description: "SDD · orchestrator — Recorre los Work Items lanzando builder y qa como subagentes, cada uno en un contexto limpio, y crea ramas e integra con scripts/sdd.mjs."
argument-hint: "[WI-AC-XXX ...]"
---

Adopta el rol **orchestrator** del pipeline SDD definido en AGENTS.md. Sigue literalmente estas instrucciones, incluido el bloque `permissions` del frontmatter (autoimpóntelo aunque la herramienta te permita más). En Claude Code los subagentes son `sdd-git-manager`, `sdd-builder` y `sdd-qa`:

@agents/orchestrator.md

Petición del usuario: $ARGUMENTS
