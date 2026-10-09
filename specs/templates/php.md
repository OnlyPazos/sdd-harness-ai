# Plantilla de stack: PHP

Estas reglas se incluyen SIEMPRE en `project_specs.md` como "Reglas base de
stack" cuando el proyecto es PHP. `spec-writer` las usa como punto de
partida y solo pregunta lo que sea específico de la app en cuestión, no
estas reglas (ya están decididas). Si el proyecto usa un framework
(Laravel, Symfony), estas reglas se complementan con las convenciones
propias del framework — pregúntalo como primera cosa si no está claro.

## Dependencias mínimas
- Composer siempre, nunca librerías copiadas manualmente (`vendor/`
  gestionado, no versionado en git salvo excepción justificada).
- Antes de añadir un paquete, justificar por qué no basta con la librería
  estándar de PHP o una función nativa.
- Preferir paquetes con versión estable (no `dev-master`) y mantenimiento
  activo. Fijar versiones con `composer.lock` versionado en git.
- Cada nueva dependencia debe registrarse en el spec como una Decisión de
  diseño (D-XXX) con la razón de por qué es necesaria.

## Estándares de código
- PSR-12 para estilo de código (usar `php-cs-fixer` o `phpcs` desde el
  inicio del proyecto).
- PSR-4 para autoloading, declarado en `composer.json`.
- `declare(strict_types=1);` al inicio de cada archivo PHP.
- Tipado explícito en parámetros y valores de retorno de funciones y
  métodos, siempre que la versión de PHP del proyecto lo soporte.

## Estructura de carpetas (proyecto sin framework o framework-agnostic)
```
src/
  Controller/         # entrada HTTP, sin lógica de negocio
  Service/            # lógica de negocio
  Repository/         # acceso a datos, único lugar con queries
  Entity/             # modelos de dominio
  Middleware/          # autenticación, validación, logging
config/
public/               # único punto de entrada accesible (index.php)
tests/
```
- Ninguna lógica de negocio ni acceso a datos debe vivir dentro de
  `public/`. El `index.php` solo hace bootstrap y enruta.

## Base de datos
- SIEMPRE prepared statements vía PDO (o el ORM del framework) —
  concatenar variables en SQL directamente es una violación grave de
  seguridad, nunca aceptable ni siquiera como "prototipo rápido".
- Un único lugar (capa de repositorio) que conoce el esquema de base de
  datos; el resto del código no construye queries.

## Seguridad
- Toda salida a HTML se escapa (`htmlspecialchars` o el motor de plantillas
  del framework) para prevenir XSS.
- Protección CSRF en cualquier formulario que modifique estado.
- Nunca usar `eval()`, `extract()` sobre input de usuario, ni
  `unserialize()` sobre datos no confiables.
- Variables de entorno vía `.env` (`vlucas/phpdotenv` si no hay framework,
  o el mecanismo nativo del framework), nunca credenciales hardcodeadas.
- Manejo de errores: excepciones tipadas, nunca `@` para silenciar
  errores. Un handler de errores centralizado que decide qué se muestra
  al usuario y qué se loguea.

## Testing
- PHPUnit como base.
- Cada Work Item que toque lógica de negocio debe incluir al menos un
  test que verifique su Acceptance Check.

## Análisis estático
- PHPStan o Psalm configurado desde el inicio (nivel mínimo razonable
  para el tamaño del proyecto, subir el nivel de estrictez con el tiempo).

## Separación de responsabilidades
- Nunca mezclar HTML y lógica PHP compleja en el mismo archivo. Si no hay
  framework con motor de plantillas, usar al menos una separación clara
  de "archivos de vista" que solo reciben datos ya procesados.
