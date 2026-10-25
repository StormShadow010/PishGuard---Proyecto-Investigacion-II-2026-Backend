# Evidencias de prueba - Backend

Fecha de ejecución: 25 de octubre de 2026.

## Entorno

- macOS.
- Node.js v24.22.1.
- PostgreSQL local, base de pruebas `pishguard_test`.
- API de pruebas en `http://localhost:3100`.
- Variables usadas: `ADMIN_KEY=test`, `FRONTEND_URL=http://localhost:4200`.

## Prueba de resiliencia

Comandos:

```bash
DATABASE_URL=postgresql://gabo@localhost:5432/pishguard_test \
PORT=3100 \
ADMIN_KEY=test \
FRONTEND_URL=http://localhost:4200 \
npm start
```

En otra terminal:

```bash
ADMIN_KEY=test \
TEST_DATABASE_URL=postgresql://gabo@localhost:5432/pishguard_test \
BASE_URL=http://localhost:3100 \
npm run test:resiliencia
```

Resultado: 26 verificaciones aprobadas.

La prueba confirmó, entre otros puntos:

- Una capacitación previa fuera del catálogo responde HTTP 400.
- Una autoeficacia fuera del rango 1 a 5 responde HTTP 400.
- La creación concurrente de la misma sesión no duplica la fila ni los ensayos.
- El reintento recupera exactamente el mismo identificador de sesión.
- Las tres variables intervinientes quedan guardadas en la misma fila de `sesiones`.
- La lista aleatoria se conserva después de recargas y fallos de red.
- Recargar antes de responder mantiene el mismo ensayo.
- Una respuesta duplicada responde HTTP 409.
- Un reintento tras perder la conexión no crea un registro nuevo.
- Dos respuestas simultáneas guardan una sola y bloquean la otra con HTTP 409.
- El primer ensayo registra `iniciada_en`.
- Al completar todos los estímulos, `POST /respuestas` registra `finalizada_en` y la sesión termina.
- La API devuelve `duracionMs` y la base calcula una duración no negativa.
- El resumen administrativo devuelve `duracion_promedio_ms` y `duracion_sesion_ms` como números.
- Una sesión inexistente responde HTTP 404.
- El endpoint `/salud` responde correctamente.
- La exportación CSV incluye `capacitacion_previa`, `frecuencia_uso`, `autoeficacia` y `duracion_sesion_ms`.
- Los datos de prueba se eliminan al finalizar.

Salida completa: [`evidencias/2026-10-25-prueba-resiliencia.txt`](evidencias/2026-10-25-prueba-resiliencia.txt).

## Verificación del esquema en Neon

Las migraciones `db/migraciones/001_variables_intervinientes.sql` y `db/migraciones/002_cronometro_sesion.sql` fueron aplicadas en la base de producción de Neon.

Salida verificada:

```text
capacitacion_previa | text | nullable=YES
frecuencia_uso      | text | nullable=YES
autoeficacia        | smallint | nullable=YES
iniciada_en         | timestamp with time zone | nullable=YES
finalizada_en       | timestamp with time zone | nullable=YES

sesiones_autoeficacia_check        CHECK (autoeficacia >= 1 AND autoeficacia <= 5)
sesiones_capacitacion_previa_check CHECK (capacitacion_previa IN ('formal', 'informal', 'no'))
sesiones_frecuencia_uso_check      CHECK (frecuencia_uso IN ('diaria', 'varias_semana', 'semanal', 'mensual', 'nunca'))
```

Salida completa: [`evidencias/2026-10-25-esquema-sesiones-neon.txt`](evidencias/2026-10-25-esquema-sesiones-neon.txt).

## Archivos de evidencia

| Archivo | Contenido |
| --- | --- |
| [`evidencias/2026-10-25-prueba-resiliencia.txt`](evidencias/2026-10-25-prueba-resiliencia.txt) | Salida completa de la prueba de integración. |
| [`evidencias/2026-10-25-esquema-sesiones-neon.txt`](evidencias/2026-10-25-esquema-sesiones-neon.txt) | Esquema de `sesiones` verificado en Neon. |
| [`db/migraciones/001_variables_intervinientes.sql`](../db/migraciones/001_variables_intervinientes.sql) | Migración reproducible de las variables intervinientes. |
| [`db/migraciones/002_cronometro_sesion.sql`](../db/migraciones/002_cronometro_sesion.sql) | Migración reproducible del inicio y fin de la sesión. |
