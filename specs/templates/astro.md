# Plantilla de stack: Astro + React (islas)

Estas reglas se incluyen SIEMPRE en `project_specs.md` como "Reglas base de
stack" cuando el proyecto es una web Astro. `spec-writer` las usa como punto
de partida y solo pregunta lo que sea específico de la app en cuestión, no
estas reglas (ya están decididas). React es el framework de las islas
interactivas; cambiarlo (Preact, Svelte, Vue...) es una Decisión de diseño
(D-XXX) explícita.

## Dependencias mínimas
- Base: `astro` + `@astrojs/react`. Antes de añadir cualquier otra
  librería, justificar por qué no basta con lo que ya ofrecen Astro
  (`astro:assets`, `astro:content`, `astro:env`, View Transitions) o la
  plataforma web.
- Evitar librerías que dupliquen funcionalidad ya cubierta (ej. no añadir
  una librería de fechas si con `Intl` alcanza, ni un router cliente).
- Prohibidas las librerías de componentes con estilos propios (MUI,
  Chakra, DaisyUI, Bootstrap...) salvo Decisión de diseño: compiten con el
  sistema de diseño del proyecto. Las primitivas sin estilos y accesibles
  (Radix, React Aria) sí se permiten, registradas como D-XXX.
- Preferir integraciones oficiales (`@astrojs/*`) sobre alternativas de la
  comunidad.
- Cada nueva dependencia debe registrarse en el spec como una Decisión de
  diseño (D-XXX) con la razón de por qué es necesaria.

## Estructura de carpetas
```
src/
  pages/              # rutas (file-based), solo composición de layouts y componentes
  layouts/            # esqueleto HTML compartido (<head>, SEO, header, footer)
  components/         # componentes .astro estáticos, sin JS en cliente
  islands/            # componentes React (.tsx) que se hidratan; único lugar con estado y efectos
  services/           # acceso a APIs/CMS, sin JSX ni .astro
  content/            # contenido de las colecciones (Markdown/MDX/JSON)
  stores/             # nanostores para estado compartido entre islas, solo si es necesario
  styles/             # tokens del sistema de diseño y estilos globales
  types/              # tipos e interfaces compartidos
  utils/              # funciones puras, sin dependencias de Astro ni React
  content.config.ts   # definición y esquema (zod) de las colecciones
public/               # estáticos servidos tal cual (favicon, robots.txt)
tests/
```

## Reglas de código
- TypeScript en modo `strict` (`tsconfig` extendiendo
  `astro/tsconfigs/strict` o `strictest`). No `any` salvo justificación
  explícita documentada en el código.
- Por defecto, todo componente es `.astro`. Un componente solo pasa a ser
  una isla React (`src/islands/`) si necesita interactividad en el cliente
  (estado, eventos, efectos). Lo estático en React es un error.
- Los datos se obtienen en el servidor o en build (frontmatter de `.astro`
  llamando a `services/` o `getCollection`) y llegan a las islas como
  props. Una isla no hace `fetch` de datos que ya estaban disponibles al
  renderizar la página.
- Si una isla necesita datos en cliente (ej. búsqueda en vivo), los pide a
  través de `services/`, nunca con `fetch` directo en el componente.
- Las props de una isla deben ser serializables (primitivos, objetos y
  arrays planos, `Date`, `Map`, `Set`): nunca funciones ni instancias de
  clase.
- Contenido local (blog, docs, catálogo) siempre en colecciones con
  esquema validado en `content.config.ts`, nunca leyendo archivos a mano.
- Variables de entorno declaradas con esquema en `astro:env` (`envField`).
  Los secretos son `access: "secret"` y `context: "server"`: nunca llegan
  al cliente ni llevan prefijo `PUBLIC_`.
- Modo de renderizado: estático (SSG) por defecto. Pasar a SSR (ya sea en
  todo el sitio o por página con `prerender = false`) requiere Decisión de
  diseño y un adapter explícito.

## Islas e hidratación
- Directiva por defecto: `client:visible`. `client:idle` para islas que
  deben estar listas pronto pero no son críticas. `client:load` solo para
  interactividad crítica por encima del pliegue, justificada en el código.
- `client:only="react"` solo si el componente depende de APIs del navegador
  imposibles de renderizar en servidor, y siempre con un fallback
  (`slot="fallback"`) que reserve el espacio para evitar saltos de layout.
- Nunca hidratar un layout entero ni una página entera para "simplificar":
  las islas son lo más pequeñas posible.
- React Context no cruza islas. El estado compartido entre islas se hace
  con `nanostores` (`@nanostores/react`), registrado como D-XXX; si una
  sola isla basta, `useState`/`useReducer` primero.
- Contenido estático dentro de una isla se pasa como `children`/slots
  desde `.astro`, no se reescribe en React.

## Estilos
- Los tokens del sistema de diseño (color, tipografía, espaciado, radios,
  sombras) viven en `src/styles/` como custom properties de CSS y son la
  única fuente de valores visuales: nada de colores ni espaciados
  hardcodeados en componentes.
- `.astro`: estilos con `<style>` (scoped por defecto). `is:global` solo
  en `src/styles/` o en el layout raíz.
- Islas React: CSS Modules consumiendo los mismos tokens. Nunca estilos
  inline salvo valores dinámicos puntuales.
- Tailwind u otro framework CSS solo como Decisión de diseño, y
  configurado para leer los tokens del sistema de diseño, no una paleta
  propia.

## Rendimiento
- Una página sin interactividad envía 0 KB de JavaScript propio. Si el
  build muestra JS en una página que no tiene islas, es un defecto.
- Imágenes siempre con `<Image />` / `<Picture />` de `astro:assets`, con
  `alt`, dimensiones y `loading="eager"` solo en la imagen principal por
  encima del pliegue.
- Fuentes autoalojadas, con `font-display: swap` y precarga solo de las
  que se usan por encima del pliegue.
- Memoización en islas (`useMemo`, `useCallback`, `React.memo`) solo donde
  el perfil de rendimiento lo justifique — no memoizar todo por defecto.

## Errores y resiliencia
- `src/pages/404.astro` siempre; `src/pages/500.astro` si hay SSR.
- Toda llamada a red en `services/` maneja explícitamente: éxito, error de
  red, timeout y respuesta con error del servidor (no solo el "happy
  path").
- Si una llamada falla durante el build, el build falla: no se publica una
  página vacía o a medias salvo Decisión de diseño con un fallback
  definido.
- Cada isla que dependa de datos remotos tiene estados explícitos
  (`loading`, `error`, `empty`, `success`) y está envuelta en un Error
  Boundary que muestra un fallback sin romper el resto de la página.

## SEO y metadatos
- Cada página define `title` y `description` propios, pasados al layout;
  el layout pinta `<title>`, `<meta name="description">`, canonical y
  Open Graph.
- `<html lang="...">` siempre establecido.
- `@astrojs/sitemap` y `robots.txt` si el sitio es público.

## Seguridad
- `set:html` nunca con contenido no confiable sin sanitizar.
- Los secretos solo se leen en código de servidor (`astro:env/server`);
  revisar que ninguna isla importe de `services/` código que los use.
- Con SSR: mantener activo `security.checkOrigin`, validar con esquema
  (`zod`) toda entrada de formularios, Actions o endpoints antes de usarla,
  y nunca loguear contraseñas, tokens ni datos sensibles completos.

## Testing
- Vitest (configurado con `getViteConfig` de `astro/config`) + React
  Testing Library para islas, `services/` y `utils/`.
- Componentes `.astro` con lógica condicional: test con la Container API
  de Astro (`experimental_AstroContainer`).
- Playwright para Acceptance Checks que impliquen navegación o
  interacción entre páginas.
- Cada Work Item que toque lógica de negocio (no solo UI) debe incluir al
  menos un test que verifique su Acceptance Check de forma automatizada.

## Accesibilidad
- HTML semántico: landmarks (`header`, `nav`, `main`, `footer`), un único
  `h1` por página y jerarquía de encabezados sin saltos.
- Todo elemento interactivo es accesible por teclado, con foco visible.
  Nunca un `div` con `onClick` donde corresponde un `button` o un enlace.
- Contraste de color mínimo WCAG AA y zona táctil mínima de 44x44px en
  controles.
- Respetar `prefers-reduced-motion` en animaciones y View Transitions.

## Linting
- ESLint (`eslint-plugin-astro` + `eslint-plugin-jsx-a11y`) + Prettier
  (`prettier-plugin-astro`) configurados desde el inicio del proyecto, no
  añadidos después.
- `astro check` sin errores antes de pasar un Work Item a `qa`.
