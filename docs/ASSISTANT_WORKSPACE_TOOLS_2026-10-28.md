# Herramientas de archivos en el asistente normal

Estado: corrección local sobre `4779e6e9`; **requiere migración y despliegue**. No se han aplicado cambios de producción en esta tarea.

## Diagnóstico

La versión anterior incorporó directo/harness pero no conectó las herramientas de archivos al catálogo del chat. El router conocía sus nombres, pero eso no crea sus implementaciones. `requirement-session` sí inyectaba las herramientas desde su host; un turno conversacional no lo hacía.

Para la instancia indicada por el usuario se confirmó mediante consultas de sólo lectura: existe un único requerimiento asociado, un workspace persistido `h-…`, sesión pausada sin lease ni cleanup activos y sin operaciones inciertas. No se leyeron archivos del proveedor, no se reanudó el runner ni se ejecutaron comandos en ese workspace. Una referencia en DB no acredita que su snapshot siga disponible.

## Comportamiento implementado

- `assistant-turn-core` añade el catálogo bajo scope de una acción confiable, antes de construir el router. Abrir el chat o construir schemas no conecta/provisiona una VM.
- Instancia independiente: `list_files`, `read_files`, `search`, `apply_patch`, `exec`, `process_status`, `process_stop` usan el mismo `createWorkspaceTools` que el harness. Primer uso crea un entorno vacío privado, sin repo obligatorio, plan ni requerimiento artificial.
- Instancia asociada a requerimiento o workflow: lecturas sobre **copia aislada del snapshot guardado**, con `snapshotId` y advertencia de que puede faltar trabajo no guardado. No se llama `resume`, `stop`, `snapshot`, `update` ni se ejecuta código en el origen. No se ejecutan scripts de repositorio durante la inspección.
- Sobre esa copia, tanto el catálogo como el adapter rechazan comandos arbitrarios, cambios de archivos y control de procesos. Ediciones del trabajo gestionado permanecen en su owner autorizado. La inspección no elimina pausas ni declara completado el requerimiento.
- Se exige el marcador de aislamiento del origen. Workspaces legacy sin él necesitan adaptación segura del host; no se cambia ownership ni se relaja el aislamiento automáticamente.
- Ausencia de snapshot, interrupción, error de permisos o falta de migración producen errores concretos. No se sustituye un workspace existente por uno vacío ni se infiere «no hay avances».
- Resolver de origen incluye terminados, pagina el historial y rechaza conflictos entre requerimientos. Referencias legacy editables se contrastan con el ledger de propiedad de facturación, además del scope del sitio.
- Argumentos/paths se validan antes de asignar recursos. El helper existente usa I/O no-follow, rechaza secretos/symlinks/hardlinks y limita resultados. No se cambian fingerprints de operaciones existentes del requirement.

## Persistencia y ciclo de vida

Migración nueva:
[20261028230000_assistant_workspace_resources.sql](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations/20261028230000_assistant_workspace_resources.sql).

- `assistant_workspaces`: registro de infraestructura por instancia, initialized sticky, recurso activo y lease de 300 segundos; no es un segundo motor de agentes.
- RPCs service-role: claim/renew/release con verificación de instancia/sitio y exclusión entre tokens. Sin concesiones a anon/authenticated.
- `register_sandbox_billing` añade owner `instance`, derivando el sitio de `remote_instances`; mantiene reglas anteriores y liquidación por sesiones reales.
- VM privada: duración de sesión acotada a 180 s, herramientas de comandos hasta 120 s; archivos en snapshot persistente sin caducidad automática, una revisión conservada hasta eliminación de la instancia. No implica retención eterna tras eliminación ni procesos ilimitados.
- Copias de inspección: red denegada, environment vacío, sin puertos, parada al terminar y snapshots temporales. No se promueve una copia de datos gestionados a entorno ejecutable.
- Eliminación de instancia: cola durable `assistant_workspace_deletions`, independiente del campo del ledger que prueba borrado preliquidado. Housekeeping conserva recursos con lease activo y usa el camino existente stop → settle → retire → delete. No se perdona uso no liquidado por borrar una fila.

## Despliegue y límites

1. Revisar/aplicar la migración anterior por el mecanismo autorizado y verificar ACL/RLS/RPCs.
2. Desplegar API con el mismo scope OIDC del proveedor usado por los workspaces; no hacer fallback silencioso a credenciales más amplias.
3. Iniciar un **nuevo turno** en la instancia y pedir `list_files`/`read_files`. Un turno ya generado no adquiere herramientas retroactivamente.
4. Verificar `workspace_source` y snapshotId; no confundir lectura guardada con live filesystem.

No se aplicó SQL remoto, no hubo commit/push ni reinicio de la instancia. Las consultas de diagnóstico fueron de sólo lectura. Pruebas offline cubren catálogo real conectado, schemas, paths, locks, billing, snapshots, aislamiento y SQL en PostgreSQL desechable; falta E2E del proveedor desplegado.

No incluye `edit_cloud_file`, escritura concurrente sobre el requerimiento, revisión de entregas, nueva política económica raíz/70%, ni resolución de los demás hallazgos de la revisión previa.

## Verificación local

- Runtime activo: **48 suites, 765 pruebas** (582 CommonJS + 183 ESM); incluye compilación real del workflow.
- Harness: **227 suites, 3598 pruebas**; agent-harness: **48 suites, 536 pruebas**; AI: **74 suites, 1151 pruebas**. Suites parcialmente solapadas.
- Billing/housekeeping focalizado: **2 suites, 21 pruebas**. La nueva migración se ejecutó en PostgreSQL PGlite desechable con casos de scope, tokens competidores, initialized sticky, revocación, borrado de instancia, ledger y denegación de roles públicos.
- TypeScript completo con `--noEmit --incremental false`: **exit 0**. `git diff --check` y links locales correctos.
- El acceso al proveedor no se probó live: no se inició una VM ni se cambió la base remota para validar esta corrección.

## Corrección posterior: indisponibilidad de permisos (503)

Base revisada: `527e0238`. El fallo observado de `list_files` ocurrió antes de la lectura. Las consultas de diagnóstico de sólo lectura confirmaron propietario, acceso efectivo y migración instalada. En el intervalo del incidente hubo una llamada a `site_user_has_effective_access` de **4857 ms**; el código anterior compartía **5000 ms** entre esa RPC y las consultas posteriores. Esto evidencia falta de margen, pero los logs antiguos no identifican de forma concluyente qué subconsulta agotó el plazo de ese turno.

La corrección local asigna **10 s por fase** (acceso efectivo, sitio, roles), con un solo reintento de la secuencia completa exclusivamente ante timeouts, errores de transporte o códigos transitorios conocidos. Si falla la comprobación de roles, el reintento vuelve a verificar acceso efectivo; no reutiliza autorizaciones parciales. No hay caché positiva ni fallback que permita acceso sin verificar.

Un propietario confirmado por la RPC y `sites.user_id` no consulta `site_members`/`site_ownership`: un error ajeno de membresía no puede vetarlo. Los demás actores conservan sus restricciones. Denegaciones, errores de esquema/privilegios y cardinalidad no se reintentan. Un transporte que ignore el abort también queda limitado por `Promise.race`.

Los logs nuevos sólo incluyen fase, categoría, código conocido, intento y duración, sin IDs de actores, credenciales, URL ni mensajes crudos de DB. La herramienta, su provisión y sus efectos están fuera del bloque de reintento.

Se verificó el código real corregido contra la base mediante una llamada de permisos de sólo lectura: propietario confirmado en **1914 ms**. No se abrió ni leyó un sandbox como parte de esa prueba. Esta corrección **no requiere otra migración**, pero sí desplegar el código; no se aplicó SQL remoto ni se hizo commit/push en esta tarea.

Regresiones finales de esta corrección: `test:ai` **76 suites / 1176 pruebas**, `test:assistant-runtime` **49 suites / 768 pruebas** (585 CJS + 183 ESM), `test:harness` **227 suites / 3598 pruebas**, TypeScript completo **exit 0** y `git diff --check` correctos. Se incluyen caída persistente, respuestas tardías, propietario con membresía inaccesible, revocación entre intentos, reglas de pantalla cambiadas, redacción de diagnósticos y `read_files` real con provider simulado, confirmando una única lectura y ninguna provisión ante permisos fallidos. Las suites se solapan; no sustituyen la prueba E2E después del despliegue.