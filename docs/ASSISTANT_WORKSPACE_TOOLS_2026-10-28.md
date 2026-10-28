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