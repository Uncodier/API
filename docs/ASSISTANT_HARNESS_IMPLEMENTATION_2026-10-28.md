# Harness: primer incremento local de implementación

Fecha: 2026-10-28. Base: API `2545ee69a811379dbf7496b802e3a0857b5a9d34`.
Estado: **implementación parcial local; sin commit, despliegue, migración ni reinicio de instancias**.
Referencia normativa: [plan](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_SIMPLIFICATION_PLAN_2026-10-28.md) y [validación](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_VALIDATION_2026-10-28.md).

## 1. Alcance implementado

- API HTTP: `execution_mode: direct | harness`. Ausente significa directo, salvo el marcador **explícito y exacto** `system_prompt="plan"` del frontend anterior. No se infiere activación por título, texto del usuario, requirement asociado o plan pendiente. `execution_mode="direct"` prevalece sobre el marcador legacy.
- La acción confiable y el snapshot de recuperación conservan la modalidad. Una continuación restaura la del snapshot, no la de sus nuevos argumentos. Calls internos y snapshots sin modalidad conservan la semántica anterior; no se migran silenciosamente.
- Directo no entra en el ejecutor del plan después de responder. Conserva herramientas/permisos actuales: esto no incorpora todavía herramientas cloud ni un workspace lazy unificado.
- Pending work pasa el ID de la acción ya persistida al workflow y evita otra acción/reset implícito del requerimiento. El marcador Plan legacy sigue admitido. Se rechaza un site discordante antes de persistir.
- Prompt del step generalista: sin cancelar por título genérico, obligación de producir código, buscar skills adicionales o imponer estructura de archivos. Conserva skills asignadas, contexto y restricciones. Mejora opcional como orientación, no como máquina de revisiones persistidas.
- Steps standalone iniciados en harness explícito usan `plan_result` con `completed`, `failed` o `needs_input`. Prosa o preguntas no completan el step. Una pregunta conserva historial y espera; no ejecuta steps posteriores. La respuesta posterior requiere entrada harness explícita/Plan y se añade al checkpoint, sin replay de los turnos guardados. Fallo declarado conserva conclusión negativa y falla el plan, sin retry automático.
- Resultado del step en memoria de host no falsificable por JSON: después de declararlo, el catálogo final devuelve recibos `executed:false` para las demás herramientas del mismo lote, incluido el router. El ejecutor standalone actual realiza una iteración por llamada; no se habilitan nuevas iteraciones después del resultado.
- SSE distingue entrega conversacional de éxito del trabajo: entrega la pregunta/conclusión negativa en `data`, conservando `data.success=false` y `execution_status`. No transforma una pregunta en un genérico «workflow incompleto».
- Historial de requirement: proyección sin reasoning/raw arguments ni copia recursiva de receipts de historial. Referencias por índice, extractos y cursor que avanza. `contentOffset` pagina la vista redactada completa de una entrada ordinaria, sin partir pares Unicode; receipts de historial sólo referencian sus mensajes originales. Se mide el receipt serializado final contra el límite existente de 350000 bytes; no se amplía la cuota ni se modifica el historial canónico.
- Permisos de herramientas: indisponibilidad/timeout produce `TOOL_SCREEN_ACCESS_UNAVAILABLE` / 503, distinguible de la denegación 403. Ninguno concede acceso. La prueba de no ejecución se adjunta sólo antes del dispatch; un error posterior no se vuelve seguro sólo por su código. Mensajes constantes, sin credenciales ni detalles de DB.

## 2. Contrato versionado de workflows

Los nuevos runs ordinarios materializados fijan `metadata.result_contract_version=2`. No se añade esa versión al template ni al bounded channel pre-response. Los runs existentes sin versión son v1; una versión desconocida se rechaza antes de ejecutar.

| Señal | v1 histórico | v2 nuevo |
| --- | --- | --- |
| Existencia genérica de actividad de herramientas | Gate anterior | Observación |
| Última herramienta fallida, aunque opcional | Gate anterior | Observación |
| Navegación/interacción inferida por heurística | Gate anterior | Observación |
| Shape de salida, acciones requeridas, browser explícito | Contrato vigente | Contrato vigente |
| Criterios y validation rules guardados | Contrato vigente | Conservados; su procedencia sigue pendiente de inventario |
| Resultado negativo honesto | Permitido | Permitido |

`assessWorkflowResult` es una evaluación pura que devuelve `contract` y `observations`. Las observaciones no participan en `gate.passed`, no tienen callbacks de estado y no rechazan el resultado. `run-plan` usa realmente v2 cuando el run lo declara; no es un helper desconectado. No se añadieron permisos ni se relajaron dry-run/pre-response, destinos, relaciones o ownership.

**No se considera D5 resuelta:** mantener un campo histórico no prueba autorización del usuario. El inventario completo de procedencia, skills y gates de requirement/cron queda pendiente. Este cambio retira sólo heurísticas identificadas del nuevo contrato ordinario.

## 3. F0: inventario local de interfaces y persistencia

Rutas relativas en esta tabla se entienden desde `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/`.

| Interfaz | Consumidores/escritores revisados | Invariante de este incremento |
| --- | --- | --- |
| Entrada assistant | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/route.ts`; pending-work; Gear email/WhatsApp | Misma firma posicional; modalidad opcional al final; permisos y créditos de admisión intactos |
| Frontend actual | `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/components/simple-messages-view/hooks/message-send-handlers.ts` y `utils.ts` | Plan sigue enviando el marcador legacy; chat ordinary no activa plan por presencia |
| Recuperación | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/robot-instance/assistant-recovery-schema.ts`, `assistant-recovery.ts`, `assistant-respawn.ts` | Snapshot/claim/cancelación conservados; intención restaurada; no replay incierto |
| Plan standalone | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/plan-steps.ts`; `instance_plan/update/core.ts` | `assistant_execution` usa estados existentes; `awaitingInput` y versión de resultado son datos del checkpoint, no nuevos enums DB |
| Workflow materializado | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/workflow-robot/materialize.ts`, `run-plan.ts`, `plan-result.ts`, `relation-routing.ts` | Template separado; IDs, outputs previos, ramas, retries y claims conservados |
| Historial/ledger | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/requirement-execution-boundary.ts` | Receipts canónicos, ownership, contadores, argumentos/fingerprints y fences inciertos no se borran |
| Vínculos existentes | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/agents/tools/requirements/create/core.ts`; `instance_plan/create/core.ts`; `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/tools/requirement-status-core.ts` | No nueva restricción de cardinalidad ni reasignación de historial en este incremento |

**F0 no está cerrado:** no se consultaron datos/versiones desplegadas, templates reales ni cardinalidad de producción; no hay mediciones live de costo/latencia. Las fixtures son sintéticas. Falta validar V1–V6 y la admisión atómica del vínculo único antes de habilitar garantías nuevas.

## 4. Verificación local

Node 22 desde `/opt/homebrew/opt/node@22/bin`; comandos desde `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/`:

```sh
npm run test:assistant-runtime
npm run test:harness
npm run test:harness:agent
npm run test:ai
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```

`test:assistant-runtime` separa suites CJS y ESM; ejecuta el compilador real de Workflow sin cargar `.env`, DB ni proveedores. Incluye materialización, runner, ramas, prompts, recuperación, aclaraciones, historial y resultados. No equivale a `next build` completo ni E2E desplegado.

El primer recorrido detectó mapas VM desactualizados y dos suites ESM seleccionadas como CJS; se corrigieron las configuraciones y se ejecutaron ambas. También se corrigió una aserción antigua de `test:ai` que buscaba el selector de modelo en el wrapper ya extraído: ahora verifica wrapper **y** core sin quitar la prohibición de selectores legacy.

La revisión encontró cuatro regresiones antes de cerrar el incremento: pregunta tratada como completion, fallo opcional con veto residual, compatibilidad de Plan y efectos posteriores al resultado dentro del lote. Tienen pruebas nuevas. No se añadió detector heurístico de preguntas ni evaluación LLM como gate.

Resultados: `test:assistant-runtime` **44 suites / 724 pruebas** (541 CJS + 183 ESM); `test:harness` **227 / 3598**; `test:ai` **74 / 1151**; `test:harness:agent` **48 / 536**. TypeScript completo (`tsc --noEmit --incremental false`) terminó con **exit 0**. `git diff --check` y verificaciones de links/fences/documentos <500 líneas pasan. Las suites se solapan: no sumar sus pruebas como cobertura única. Pruebas sintéticas no acreditan recuperación live, publicación Git o presupuesto raíz.

## 5. Migración y rollback

- No hay SQL nuevo ni cambios aplicados a DB; los campos se añaden a JSON existente. Esto **no** garantiza rollback a lectores antiguos: el parser previo de recovery rechaza claves desconocidas y el ejecutor anterior desconoce `awaitingInput`/resultado explícito.
- Antes de desplegar: validar contrato real y runners activos; ensayar fixtures de checkpoint legacy/directo/harness/pregunta y materialización v1/v2; mantener el nuevo lector para cualquier snapshot creado con modalidad.
- Rollback seguro: detener admisión nueva y drenar/conciliar owners; conservar lectores nuevos para snapshots nuevos o migrar explícitamente con pruebas. No borrar keys/versiones a ciegas ni reanudar una espera de input con el código antiguo.
- Los runs ya materializados conservan su versión. No cambiar v2 a v1 con un update masivo ni editar outputs consumidos. No recrear runs para sortear un fallo de Git o de permisos.
- No se desplegó ni ejecutó ningún caso live. Archivos de runtime, documentación y fixtures quedan sin commit para revisión. No se tocaron los cambios concurrentes POS/commerce del repositorio vecino.

## 6. Pendiente, sin declaración de terminado

- Resto F1: continuation por turno del step standalone, plan mínimo del requirement, snapshots de baseline/candidato y revisión explícita de entregas completadas.
- F2: presupuesto raíz, fallback 70%, compromisos transaccionales, margen y política `budget=null`; no se modificó ninguna de esas reglas.
- F3: ingreso concurrente y control unificado, wakes durables, revisión de pausas técnicas. El outage de permisos durante `assertActive` aún conserva la pausa fail-closed; 503 no autoriza automáticamente su reanudación.
- F4: `edit_cloud_file`, destino Git privado, archivo de revisión exacta, separación ejecución/evidencia/entrega, entornos lazy y procesos largos. No implementados.
- F5/F6: subworkflows parent-child, liberación de recursos, integración frontend y E2E aislado, rollout y retiro del legacy.
- Cero/un requerimiento por instancia y lectura de terminados no están resueltos por este incremento. No hay nueva admisión atómica ni reparación de datos.
- Se mantienen límites actuales (10 turnos standalone por tramo, 20 conversacionales y límites vigentes de workflows). No se amplió autonomía prolongada antes del presupuesto/control/persistencia necesarios.