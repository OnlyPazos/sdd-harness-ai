# design-system/ — base de sistema de diseño

Esta carpeta es **agnóstica de lenguaje**. Vive independiente de cualquier
app y puede copiarse a una app concreta cuando su stack esté decidido.

## Qué hay aquí

```
design-system/
├── tokens/              # valores semánticos en JSON (neutral para cualquier lenguaje)
│   ├── colors.json
│   ├── typography.json
│   ├── spacing.json     # espaciado y radios
│   ├── sizes.json       # dimensiones de componentes (alturas mínimas, bordes…)
│   ├── motion.json      # duraciones y easings
│   └── tokens.css       # GENERADO desde los JSON — no editar a mano
├── scripts/
│   ├── build-tokens.mjs     # JSON → tokens.css (--check para CI)
│   ├── check-contrast.mjs   # valida WCAG AA de los pares declarados
│   └── contrast-pairs.json  # pares de color que usan los componentes
└── components/
    └── button/          # ejemplo en web estándar: Web Component <ds-button>
```

## Comandos

Requieren Node 18+ y no tienen dependencias.

```bash
node design-system/scripts/build-tokens.mjs           # regenera tokens/tokens.css
node design-system/scripts/build-tokens.mjs --check   # falla si tokens.css está desactualizado
node design-system/scripts/check-contrast.mjs         # falla si algún par no cumple WCAG AA
```

Los JSON son la única fuente de verdad: cambia un valor allí y regenera.
Los dos comandos de comprobación están pensados para ejecutarse en CI.

## Usar el Button (web estándar)

```html
<link rel="stylesheet" href="design-system/tokens/tokens.css">
<script src="design-system/components/button/button.js"></script>

<ds-button variant="primary">Guardar</ds-button>
<ds-button variant="secondary" size="sm">Cancelar</ds-button>
<ds-button type="submit" loading>Enviando…</ds-button>
```

`button.css` no se enlaza en la página: el componente la carga dentro de
su Shadow DOM. Abre `components/button/button.html` en el navegador para
ver todas las variantes.

## Cómo trabajan los roles

(Ver `AGENTS.md` y `agents/` en la raíz. Se invocan con `rol: <nombre>` o
con el atajo de tu herramienta.)

- **`design-builder`** detecta la sintaxis de `components/` por sus
  extensiones (`.tsx`, `.vue`, `.svelte`, `.php`/`.blade.php`, `.html`…)
  y solo crea/edita componentes en esa sintaxis. Si la carpeta está vacía,
  pregunta el lenguaje antes del primer componente.
- Si `tokens/` está vacía o le pides un sistema nuevo, `design-builder`
  entra en **modo arranque**: te entrevista (marca, tipografía, densidad,
  modo oscuro), propone tokens y componentes base, valida el contraste y
  los genera tras tu confirmación.
- Los componentes **siempre toman sus valores de `tokens/*.json`** — nunca
  colores, tamaños o espaciados sueltos.
- Los estados de focus, disabled, loading y error, y la accesibilidad
  (contraste WCAG AA, teclado, zonas táctiles de 44px) son obligatorios.
- **`design-extractor`** genera `design_system.md` documentando lo que
  existe de verdad (tokens + componentes en cualquier lenguaje), su
  conformidad de accesibilidad y las inconsistencias detectadas.

## Tokens incluidos

- `colors.json` — roles semánticos (`background`, `surface.*`, `text.*`,
  `border.*`, `feedback.*`, `focus`).
- `typography.json` — escala (`display`, `heading`, `subheading`, `body`, `caption`).
- `spacing.json` — `spacing.1..8` y `radii.*`.
- `sizes.json` — alturas mínimas del botón, zona táctil mínima (`hit-area`),
  grosor de borde, tamaño del spinner.
- `motion.json` — `duration.*` y `easing.*`.

Son un punto de partida, no una imposición. Para categorías nuevas
(sombras, breakpoints, z-index…), pídeselas a `design-builder`: las
propondrá y las añadirá tras tu confirmación.
