# Plantilla de stack: Backend ExpressJS

Estas reglas se incluyen SIEMPRE en `project_specs.md` como "Reglas base de
stack" cuando el proyecto es un backend Express. `spec-writer` las usa como
punto de partida y solo pregunta lo que sea específico de la app en
cuestión, no estas reglas (ya están decididas).

## Dependencias mínimas
- Antes de añadir cualquier librería, justificar por qué no basta con
  `express` + Node core (ej. no añadir una librería de utilidades de
  strings si con métodos nativos alcanza).
- Preferir librerías de bajo peso y sin dependencias transitivas pesadas.
- Cada nueva dependencia debe registrarse en el spec como una Decisión de
  diseño (D-XXX) con la razón de por qué es necesaria.
- Librerías base recomendadas por defecto (no añadir más sin justificar):
  `helmet` (cabeceras de seguridad), `cors`, `dotenv` (config), un
  validador de esquemas (`zod` recomendado sobre `joi` por tener tipado
  nativo con TypeScript).

## Estructura de carpetas
```
src/
  routes/            # definición de endpoints, sin lógica de negocio
  controllers/        # orquestan validación + llamada a services + respuesta
  services/            # lógica de negocio pura, sin conocer HTTP
  repositories/        # acceso a datos, único lugar con queries/ORM
  middlewares/          # auth, validación, manejo de errores, logging
  config/               # carga y validación de variables de entorno
  types/                # tipos compartidos
config/
tests/
```

## Reglas de código
- TypeScript en modo `strict` (si el proyecto usa TS; si es JS puro,
  documentarlo como Decisión de diseño explícita).
- Cada endpoint sigue el flujo: `route → middleware de validación →
  controller → service → repository`. Un controller nunca hace queries
  directamente a la base de datos.
- Formato de respuesta consistente en toda la API, por ejemplo:
  ```json
  { "success": true, "data": {...} }
  { "success": false, "error": { "code": "...", "message": "..." } }
  ```
- Manejo de errores async centralizado: un middleware de errores único al
  final de la cadena, y un wrapper (`asyncHandler` o similar) para evitar
  `try/catch` repetido en cada controller.
- Variables de entorno validadas al arrancar la app (esquema con `zod` o
  similar) — la app falla rápido si falta una variable requerida, no falla
  silenciosamente más adelante.

## Seguridad
- `helmet` activo por defecto.
- CORS configurado explícitamente (nunca `origin: '*'` en producción sin
  que sea una Decisión de diseño documentada).
- Rate limiting en endpoints públicos o de autenticación
  (`express-rate-limit` o equivalente).
- Toda entrada de usuario se valida con un esquema antes de llegar al
  controller (nunca confiar en `req.body` sin validar).
- Nunca loguear contraseñas, tokens, ni datos sensibles completos.
- Queries parametrizadas siempre — nunca concatenar strings en SQL.

## Logging
- Logging estructurado (`pino` recomendado por rendimiento) en vez de
  `console.log`.
- Cada request relevante loguea: método, ruta, status, tiempo de
  respuesta, y un id de correlación si el proyecto tiene múltiples
  servicios.

## Testing
- Jest + Supertest como base para tests de integración de endpoints.
- Cada Work Item que agregue o modifique un endpoint debe incluir al
  menos un test que verifique su Acceptance Check contra el status code
  y el shape de la respuesta.

## Versionado de API
- Prefijo de versión explícito desde el inicio (`/api/v1/...`), aunque
  solo exista una versión por ahora.

## Linting
- ESLint + Prettier configurados desde el inicio del proyecto.
