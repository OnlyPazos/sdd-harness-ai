# Plantilla de stack: Expo (React Native)

Estas reglas se incluyen SIEMPRE en `project_specs.md` como "Reglas base de
stack" cuando el proyecto es una app Expo. `spec-writer` las usa como punto
de partida y solo pregunta lo que sea específico de la app en cuestión, no
estas reglas (ya están decididas).

## Dependencias mínimas
- Antes de añadir cualquier librería, justificar por qué no basta con lo
  que ya ofrece Expo SDK / React Native core.
- Evitar librerías que dupliquen funcionalidad ya cubierta (ej. no añadir
  una librería de fechas si con `Intl` alcanza).
- Preferir librerías mantenidas activamente y con soporte oficial de Expo
  (ver "Expo compatible libraries") sobre alternativas genéricas de RN.
- Cada nueva dependencia debe registrarse en el spec como una Decisión de
  diseño (D-XXX) con la razón de por qué es necesaria.

## Estructura de carpetas
```
app/                  # rutas (expo-router), un archivo = una pantalla
  (tabs)/
  (auth)/
components/           # componentes de UI reutilizables, sin lógica de negocio
hooks/                # hooks custom (useX), lógica reutilizable con estado
services/             # llamadas a API, sin JSX
store/                # estado global, solo si es estrictamente necesario
constants/            # colores, tamaños, textos estáticos
types/                # tipos e interfaces compartidos
utils/                # funciones puras, sin dependencias de React
```

## Reglas de código
- TypeScript en modo `strict`. No `any` salvo justificación explícita
  documentada en el código.
- Componentes funcionales con hooks; no componentes de clase.
- Estilos con `StyleSheet.create`, nunca estilos inline salvo casos
  dinámicos puntuales.
- La capa de `services/` (llamadas a API) está completamente separada de
  los componentes: un componente nunca hace `fetch` directamente.
- Manejo de estado: usar `useState`/`useReducer`/Context primero. Solo
  introducir una librería de estado global (Zustand, Redux, etc.) si el
  spec documenta explícitamente por qué el estado local no alcanza.
- Variables de entorno vía `app.config.ts` + `expo-constants`, nunca
  hardcodeadas en el código.

## Rendimiento
- Listas largas: `FlatList`/`FlashList`, nunca `ScrollView` con `.map()`
  para listas de tamaño variable o potencialmente grande.
- Memoización (`useMemo`, `useCallback`, `React.memo`) solo donde el perfil
  de rendimiento lo justifique — no memoizar todo por defecto.
- Imágenes optimizadas (`expo-image` en vez de `Image` de React Native
  cuando el proyecto ya usa Expo SDK 50+).

## Errores y resiliencia
- Al menos un Error Boundary global que capture errores de render.
- Toda llamada a red maneja explícitamente: éxito, error de red, timeout,
  y respuesta con error del servidor (no solo el "happy path").
- Estados de carga (`loading`, `error`, `empty`, `success`) explícitos en
  cualquier pantalla que dependa de datos remotos.

## Testing
- Jest + React Native Testing Library como base.
- Cada Work Item que toque lógica de negocio (no solo UI) debe incluir al
  menos un test que verifique su Acceptance Check de forma automatizada.

## Accesibilidad
- Elementos interactivos con `accessibilityLabel` y `accessibilityRole`
  cuando el texto visible no sea suficientemente descriptivo.
- Contraste de color y tamaño de zona táctil mínimo (44x44pt) en botones.

## Linting
- ESLint (`eslint-config-expo` o equivalente) + Prettier configurados
  desde el inicio del proyecto, no añadidos después.
