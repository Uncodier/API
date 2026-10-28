# Validación y revisión de consistencia del plan del harness

Fecha: 2026-10-28. Estado: especificación pendiente, **no evidencia de implementación**.
La implementación parcial local se registra por separado en [primer incremento](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_IMPLEMENTATION_2026-10-28.md); estos casos siguen siendo criterios, no garantías desplegadas.
Parte normativa del [plan principal](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_SIMPLIFICATION_PLAN_2026-10-28.md). Se separa para mantener documentos por debajo de 500 líneas, sin duplicar políticas.
Base del código revisado: API `2545ee69a811379dbf7496b802e3a0857b5a9d34`; no se consultó ni modificó producción en esta revisión.

## 1. Hallazgos de la revisión y corrección de diseño

| ID | Riesgo encontrado | Corrección mínima y sección del plan |
| --- | --- | --- |
| R01 | Evidencia Git obligatoria podía mantener el agente/VM activos sin trabajo útil | Separar ejecución terminal, evidencia y entrega; liberar recursos y publicar mediante infraestructura, no repetir steps (§9.5) |
| R02 | A03 decía «sin Git obligatorio», contradiciendo el cierre exigido | Sin repo/checkout aportado por usuario; evidencia Git gestionada sí obligatoria (A03) |
| R03 | Directo podía caer en autoejecución de plan pendiente | Modalidad persistida y activación explícita; no inferirla de asociación/plan presente (§4.1, F1) |
| R04 | «Raíz» sin frontera: cada prompt podía renovar 70% o ninguna petición futura podía trabajar | Identidades de encargo y ocurrencia; continuaciones preservan presupuesto; D6 decide nuevos encargos/revisiones/recurrencias (§8.2) |
| R05 | Reserva de cuenta no impedía comprometer dos veces el presupuesto de un requerimiento | Admisión atómica cuenta + requerimiento + raíz; hijos subasignados (§8.2, A30) |
| R06 | Padre esperaba child reteniendo cupo/lock que el child necesitaba | Espera durable, liberación de recursos y transferencia segura o aislamiento; resultado antes de wake (§5.2, A29) |
| R07 | Promesa lazy no cubría flags heredados que hoy provisionan antes del turno | Flags como capacidad/configuración; efecto browser explícito conserva su obligación sin bootstrap universal (§9.1, A33) |
| R08 | «Hash y adaptar al próximo punto» podía cambiar el contrato de un run con outputs ya consumidos | Definición materializada fijada; cambios de grafo/shape requieren nuevo run o revisión explícita (§10, A17) |
| R09 | F0 exigía todas las decisiones; F1/F4 no distinguían desarrollo de habilitación | Dependencias de rollout por incremento; no autonomía prolongada sin budget ni mutaciones compartidas sin ownership (§12) |
| R10 | Unicidad mal aplicada podía destruir historial o dejar writers sin control | Fuente canónica de binding; expansión/lectores/saneamiento/escritores/restricciones (§10, §14, A34) |
| R11 | Git para todos sin destino gestionado podía exigir configuración al usuario | Destino documental privado de plataforma y control de acceso de historia, sin VM (V6, §9.5) |
| R12 | Cloud, Git, ZIP y workspace podían mostrar revisiones distintas | Manifest de entrega inmutable, autoridad de escritura explícita y cache/edición por versión (§9.5, A23/A35) |
| R13 | «Usar cron existente» no identificaba recuperación de directo, children o evidencia | F3/F4a deben implementar wake/publicación sobre infraestructura existente, no asumir que el cron de requerimientos ya lo hace (A32) |
| R14 | Esperas y Git pendiente podían inmovilizar el 70% o reanudar con saldo ya gastado | Liberar compromisos no usados, mantener techo/gasto y re-reservar al despertar sin nuevo cálculo; D4/D6 fijan política (§8.2, A31) |
| R15 | «No repetir completados» podía impedir mejorar entregas, o la mejora podía reiniciar efectos ya realizados | Rondas de mejora distintas de retries; baseline/candidato y revisión vinculada conservan resultados históricos, presupuesto y efectos (§5.5, A37-A43) |
| R16 | Review/gates históricos podían conservar veto con otro nombre o convertirse en criterio nuevo por estar persistidos | Observaciones de mejora sin autoridad de estado; procedencia de reglas, contratos explícitos separados y retiro de llamadas activas a heurísticas (§5.6, A44-A47) |

Estas correcciones no autorizan nuevas tablas, servicios, permisos ni cambios de producto no aprobados. F0 debe elegir representación mínima compatible y registrar límites que no pueda satisfacer.

## 2. Frontera del encargo y modalidad

Contrato de identidad propuesto; reglas económicas nuevas siguen pendientes donde se indica D6. Un mensaje no equivale automáticamente a una raíz, y una instancia dedicada mantiene su único requerimiento aunque acumule revisiones/ocurrencias de ese mismo trabajo.

| Evento | Identidad de trabajo | Efecto sobre plan y presupuesto |
| --- | --- | --- |
| Reentrega del mismo request/webhook | Misma instrucción/ocurrencia deduplicada | Sin nueva ejecución ni compromiso |
| Respuesta a aclaración o instrucción durante trabajo | Misma raíz | Ajuste autorizado, sin recalcular 70% |
| Timeout, retry técnico, cambio de worker | Misma raíz y step/intento lógico | Conserva recibos y gasto; no retry de negocio por el transporte |
| Directo pasa a ejecutar el plan de ese encargo | Misma raíz | Activación explícita; no nuevo presupuesto por modalidad |
| Directo invoca subworkflow para su petición | Child de la misma raíz | No activa además el plan principal ni otro 70% |
| Revisión/mejora pertinente antes del cierre | Ronda identificada dentro de la misma raíz y step/plan | Sin retry artificial, nuevo presupuesto o cambio de modalidad; el modelo itera mientras aporta dentro del encargo |
| Usuario pide mejorar una entrega previa | Revisión vinculada con baseline de entrega, sin reescribir el run anterior | Admisión según D6; «mejora» no autoriza repetir efectos ni renovar presupuesto; no exige reactivar todo el plan |
| Nuevo pedido sobre el mismo requerimiento tras entrega | Revisión/admisión explícita, no reset implícito | D6 fija consumo del remanente; no reapertura del plan salvo intención |
| Nuevo encargo independiente sin requerimiento | Nueva raíz sólo cuando la intención lo establece | D6 fija nueva admisión; no heredar incertidumbres/efectos como si fueran el mismo encargo |
| Otro requerimiento en instancia ya dedicada | Otro flujo de instancia | No selector ni reasignación silenciosa |
| Nueva ocurrencia programada | Clave estable de schedule+ocurrencia; nueva raíz o revisión según contrato | Autorización de schedule existente; D6 fija asignación por ocurrencia y límites compartidos |
| Git/entrega pendiente después del resultado | Misma operación de publicación | No nuevo modelo, step, raíz ni cargo de trabajo repetido |

Una intención ambigua que cambia materialmente alcance/presupuesto se aclara. No añadir un clasificador obligatorio ni preguntar por cada mensaje; las continuaciones evidentes mantienen contexto automáticamente.

## 3. Resultado, evidencia y progreso sin bloqueos circulares

Tres dimensiones lógicas (no nuevos enums obligatorios del esquema):
- **Ejecución:** activa, esperando, pausada/cancelada o terminal con conclusión. Usa los contratos existentes de plan/step.
- **Evidencia:** pendiente, confirmada, conflicto o error con operación identificable y próxima acción.
- **Entrega:** no disponible, resultado accesible o entrega íntegra confirmada. Integridad exige evidencia Git según el plan.

El callback que guarda la conclusión y `plan_result` no debe mantener al worker esperando Git. La publicación trabaja sobre versiones fijadas y es idempotente. Si un step requiere el SHA como output explícito, espera esa dependencia sin repetir sus efectos previos; los demás no inventan dicho requisito.
Aplicar evidencia a los entregables/conclusiones del encargo: una condición interna, un mensaje de progreso o una pregunta no necesita su propio commit. Agregar evidencia del run sin modificar el shape de cada step; respetar contratos que sí exijan un commit individual.
Git inaccesible no se etiqueta como tarea ejecutándose ni convierte éxito semántico en fracaso del negocio. Mostrar resultado accesible y evidencia incompleta; emitir incidencia técnica con responsable. D7 fija cuánto reintentar y cómo resolver imposibilidad permanente. No afirmar entrega íntegra sin evidencia ni reactivar indefinidamente el modelo.
No escribir datos sensibles en Git sólo para satisfacer el requisito: evidencia minimizada de resultados autorizados. El destino debe cubrir acceso histórico y política de eliminación, no sólo permisos de la revisión actual.
Los ciclos de mejora son capacidad del ejecutor, no un tercer modo ni un validador universal. Antes del cierre, el step puede implementar, revisar y corregir sin emitir resultados terminales intermedios. Después de la entrega, una revisión autorizada conserva el resultado original y los consumidores que lo usaron. Adoptar candidato no reenvía ni redespliega automáticamente; revalidar sólo dependencias afectadas con los permisos vigentes.
Revisión sin cambios, mejora no pertinente o presupuesto insuficiente para optimizaciones opcionales no convierten una entrega válida en fallo. Una obligación explícita incumplida sí se reporta como tal. Preservar la mejor versión conocida mediante cambios aislados y control de concurrencia; no prometer restaurar efectos externos ni una medición objetiva universal de calidad.
Separación verificable: un componente de revisión retorna hallazgos con referencia de versión/evidencia, aplicabilidad y acciones posibles; no recibe autoridad para mutar estados, rechazar `plan_result` o crear nuevos criterios. El executor consume el feedback y puede continuar o concluir. Una sugerencia de prueba/telemetría no es un requisito obligatorio salvo que proceda del encargo/política autorizada; un score de reviewer no acredita ni refuta por sí solo cumplimiento.
Los controles obligatorios rechazan sólo la acción, formato o declaración de éxito que no satisface su contrato. Siempre conservar una salida factual negativa/incompleta compatible; no transformar cada rechazo de formato o ausencia de medición en pausa de reconciliación. La falta de prueba no acredita éxito: se registra como no verificada y se aplica el criterio explícito, si existe.

## 4. Decisiones pendientes por incremento

| ID | Decisión | Propuesta/no resuelto | Antes de habilitar |
| --- | --- | --- | --- |
| D1 | Alcance de autonomía externa | Ejecutar efectos ya autorizados por intención/workflow; preguntar ampliaciones/ambigüedad. Mantener políticas vigentes hasta confirmación; no nuevo permiso general | Cualquier ampliación de permisos; no bloquea correcciones internas |
| D2 | 70% por tarea o reserva global | Propuesta actual: 70% de saldo libre al admitir raíz, no suelo global del 30%. Necesita confirmar semántica con concurrencia | F2 nuevo fallback |
| D3 | `budget=null` histórico | No reinterpretar unlimited como fallback sin política y migración; no extender unlimited a nuevos encargos por accidente | F2 cambio de semántica/backfill |
| D4 | Margen de cierre, compromisos y retención | Ingeniería estima costo, cuota/TTL y compromisos durante espera; producto aprueba límites visibles. No un porcentaje oculto ni conservación infinita | F2 cierre/esperas y F4 persistencia |
| D5 | Gates inferidos frente a requisitos explícitos | Inventariar procedencia, no sólo campos guardados: heurística generada no es consentimiento. Retirar veto accidental bajo versión; conservar shape, permisos y requisitos autorizados. Casos de procedencia ambigua se revisan de forma acotada | F1 cambio de validación |
| D6 | Nuevas peticiones, revisiones y recurrencias | Recomendación: revisiones/mejoras posteriores ligadas consumen remanente compartido; nueva ocurrencia no resetea presupuesto explícito global; presupuesto por ocurrencia requiere definición. Encargo nuevo sin requerimiento admite nueva raíz, retry no. Las mejoras dentro del encargo ya comparten raíz/techo; política de posteriores pendiente | F2 y activación de escenarios recurrentes/nuevas raíces |
| D7 | Evidencia Git permanentemente pendiente | Trabajo terminal y resultado accesible; incidencia técnica sin repetir agente. Definir horizonte/backoff, responsable y resolución manual o política de excepción explícita, no waiver silencioso | F4a cierre Git |

| ID | Comprobación de ingeniería | Evidencia requerida | Incremento |
| --- | --- | --- | --- |
| V1 | Duración, renovación y recursos del proveedor/Workflow | Proceso largo, cambio de worker y un cupo sin deadlock; límites instalados comprobados | F1/F4b/F5 |
| V2 | Credenciales, red, browser y permisos | Capacidad real, renovación scope correcto y denegación sin confundir outage | F4 |
| V3 | Concurrencia, recibos, presupuesto y wakes | PostgreSQL multi-conexión y fallos antes/después de persistencia; no sólo mocks/hashes | F2/F3/F5 |
| V4 | Esquema, consumidores y versiones desplegadas | Matriz de invariante/fuente/operación/escritores/backfill; compatibilidad y rollback ensayados | F0 y cada incremento |
| V5 | UX y calidad | Baseline y casos A01-A47; medir beneficio de ciclos de mejora, regresiones, falsas negativas y costo sin imponer score universal | Cada incremento/F6 |
| V6 | Destino Git/documentos y UI existentes | Provisión sin usuario/VM, repo privado y ACL de historia, CI no disparado, retención/eliminación, archive de misma revisión y descarga compatible | F4a |

No convertir D4-D7 en prerrequisito para corregir un prompt o el deadlock de pausa existente bajo el presupuesto actual. Sí bloquear habilitación de nuevas garantías económicas/Git hasta resolver su política.

## 5. Matriz de aceptación

| ID | Escenario | Resultado exigido |
| --- | --- | --- |
| A01 | Petición con dato indispensable ausente | Pregunta antes de trabajo sustantivo; respuesta continúa la misma raíz |
| A02 | Incógnita técnica durante trabajo | Agente investiga/cambia herramienta sin pausa administrativa ni datos inventados |
| A03 | Informe sin repo del usuario que requiere cálculo | Web + workspace vacío + entregable; evidencia Git en destino gestionado sin exigir checkout/configuración al usuario |
| A04 | Step amplio con >10 turnos y varios tramos | Mismo step lógico, progreso conservado, sin failure por timeout del transporte |
| A05 | Workflow con ramas, outputs y retries | Conserva `plan_result`, interpolación, condiciones y no repite completados como recovery; revisiones de mejora son explícitas y versionadas |
| A06 | Herramienta/test falla; otro camino cumple objetivo | Feedback y corrección; no exige una herramienta accidental ni falsa aceptación |
| A07 | Nueva instrucción durante modelo/tool | Recepción durable, aplicación segura y ningún worker competidor |
| A08 | Reintento de pausa técnica sin efecto incierto | Nueva acción útil verificable; no basta status cambiado |
| A09 | Timeout antes/después de escritura externa | No ejecutado se reintenta; incierto se consulta, no se duplica |
| A10 | Caída de DB/permisos/auditoría | No se concede acceso; recuperación sin traducir outage en revocación permanente |
| A11 | Proceso >120 s y cambio de worker | Estado/logs consultables; proceso no muere por terminar la llamada |
| A12 | Pérdida de sandbox con binarios/texto | Restauración desde captura confirmada; pérdidas y procesos interrumpidos explícitos |
| A13 | Historial largo y resultado enorme | Compacta, pagina y avanza; no crecimiento por relectura recursiva |
| A14 | Presupuesto explícito, cero, ausente y legacy null | Semántica versionada correcta; cierre con margen y sin reset por retry |
| A15 | Dos tareas y subflujos concurrentes | Compromiso atómico sin doble descuento/cargo ni atribución |
| A16 | Serie de children, respuesta perdida y cancelación | IDs reutilizados, outputs conservados y stop propagado sin fingir reversión |
| A17 | Cambio de contrato con child activo/outputs consumidos | Versión compatible continúa; template nuevo no muta el run; migración explícita sin borrar ni mezclar contratos |
| A18 | Cierre/reapertura de UI y Resume | Trabajo independiente del cliente; estado corresponde a ejecución real |
| A19 | Presupuesto bajo al final o proveedor caído | Entrega persistida o recibo determinista; cierre no agota fondos de forma evitable |
| A20 | Pre-response, dry-run, publicación y aislamiento | No efectos prohibidos, permisos ampliados ni secretos en resultados |
| A21 | Chat normal escribe/edita/busca/entrega Markdown | Sin requerimiento/cron de trabajo ni sandbox; documento privado y versionado |
| A22 | Chat busca archivos del workspace sin VM | Provisión autorizada una vez; búsqueda repetida reutiliza binding; catálogo/cloud search no provisionan |
| A23 | Ediciones cloud concurrentes e import/export | Conflicto de versión accionable y recibo idempotente; no pérdida de cambios confirmados |
| A24 | Sandbox caído o eliminado durante investigación | Entregables cloud siguen accesibles/editables; restauración no borra documentos |
| A25 | Commit remoto, conflicto y respuesta perdida | Sin sandbox; commit vinculado a revisión exacta, sin overwrite/duplicación/deploy documental; estado pendiente veraz |
| A26 | Panel documental de conversación sin requerimiento | Mismo visor y navegación; contenido privado y refresh de versión correctos, sin status ficticio |
| A27 | Cero/un requerimiento, doble asignación y datos históricos | Primer vínculo atómico; otro requerimiento usa otra instancia; terminado revisable; conflicto no elige último status |
| A28 | Cierre positivo/negativo con Git disponible/caído | Ejecución terminal, recursos liberados, evidencia pendiente/confirmada separada; retry Git no repite trabajo |
| A29 | Padre/hijo con un cupo y workspace compartido | No espera circular; transferencia segura de acceso; resultado persistido despierta padre aun perdiendo el aviso |
| A30 | Dos raíces/revisiones del mismo requerimiento | Respeta presupuesto agregado de requerimiento además del saldo de cuenta; no renueva por nueva raíz |
| A31 | Pregunta/pausa larga, saldo gastado por otra tarea | Libera compromisos no usados, conserva techo/gasto y re-reserva al despertar; insuficiencia visible sin sobregiro |
| A32 | Dispatch/wake perdido sin requerimiento asociado | Directo/child/evidencia se recuperan por identidad y trabajo debido; no dependen del cron de requerimientos ni del cliente |
| A33 | Plan pendiente en directo y flags legacy sandbox/browser | No activa plan ni VM por presencia; acción explícita cumple el contrato; no se eluden restricciones |
| A34 | Migración de vínculo/estado con writers viejos y nuevos | Expansión y saneamiento preservan historial; todos los writers respetan unicidad; rollback compatible |
| A35 | Cloud actualizado mientras se publica commit/ZIP anterior | Entrega usa un manifest fijo; UI/commit/archive no mezclan revisiones y edición stale informa conflicto |
| A36 | Nuevo encargo/revisión/recurrencia y reentrega de evento | Admisión según D6, ocurrencia deduplicada; ni reset por mensaje ni presupuesto eterno accidental |
| A37 | Usuario pide mejorar un step o plan funcional | Revisión con objetivo y baseline, cambios pertinentes y verificación; no marcar fallo ficticio ni repetir todo el trabajo |
| A38 | Loop revisa calidad antes de concluir, con/sin mejora útil | Puede iterar y corregir; también concluir sin cambios cuando corresponda, sin rondas mínimas ni score/gate universal |
| A39 | Mejora de integración entre steps/subworkflows o plan completo | Selecciona alcance parcial/completo justificado, revisita mediante revisiones vinculadas, versiona outputs adoptados y no repite efectos de ramas ya ejecutadas |
| A40 | Mejora tras entrega y retry de su instrucción | Revisión deduplicada vinculada al resultado previo; conserva historial y no publica/envía/migra de nuevo por defecto |
| A41 | Candidato introduce regresión o edición concurrente | Corrige/descarta candidato sin perder baseline ni cambios ajenos; no marca candidato fallido como entrega vigente |
| A42 | Ciclo propone telemetría o nueva integración | Instrumentación y verificación dentro de alcance; no exportar secretos/PII ni crear gasto o tracking no autorizado; faltantes explícitos |
| A43 | Varias rondas de mejora y margen de cierre cercano | Mismo techo y sin aumentar retry_count; detiene mejora opcional, entrega revisión válida con evidencia Git y pendientes, no perfeccionamiento infinito |
| A44 | Implementación válida por herramienta alternativa frente a heurística/reviewer adverso | Observación no tiene callbacks de estado ni veto; contrato real satisfecho permite finalizar sin receta/score accidental |
| A45 | Revisión no aplicable, test no ejecutable o recomendación sin ganancia | Diferenciar no aplica/no verificado/fallo observado; no nuevo gate, pausa global ni repetición de revisión sin cambio/evidencia nueva |
| A46 | Falta requisito explícito o permiso mientras se retira el gate antiguo | No falso éxito ni bypass; guardar resultado y concluir negativamente o pedir lo indispensable, sin obligación de agotar retries |
| A47 | Desactivar política opcional de mejora y verificar ruta productiva | Continúa ejecución y contrato base; permisos intactos, sin gate retirado alcanzable desde wrappers ni flags alternativos que cambien ownership |

## 6. Método, observabilidad y dependencias

- Unitarias: esquemas, clasificación de errores, contexto, paginación y proyecciones. Fixtures con credenciales sintéticas generadas en runtime; no cargar `.env` real.
- Integración local: runtime real con providers simulados en el borde; demostrar conexión entre entrada, ownership, dispatch, tool result, cierre, evidencia y UI. No sustituir todo el ciclo por un resultado scripted y llamarlo E2E.
- PostgreSQL multi-conexión: reservas conjuntas, unicidad, CAS, wake perdido y transferencias; PGlite aislado no acredita contención real.
- Staging live: tenant/repo/recursos desechables, autorización explícita y presupuesto; cleanup por IDs exactos. Fallar visiblemente si la fixture está ausente, no producir éxito vacío.
- Tareas largas: una corrida >1 hora y procesos de varios minutos con varias compactaciones y cambios de worker; evaluar entregable, no patrón exacto de llamadas.
- Cada ejecución registra versiones de API/contrato/workflow, identidades scoped, eventos, gasto, entregables, checkpoint, estado Git y cleanup. No prompts privados ni secretos en métricas/snapshots.
- Medir tiempo a primera acción útil, instrucciones huérfanas, recuperaciones, intervención por infraestructura, entregables conservados, duplicación y costo por resultado. Latencia/calidad necesitan baseline; aislamiento/no duplicación no se negocian como promedio.
- Para ciclos de mejora, registrar objetivo, revisión base/candidata/adoptada, cambios, verificación pertinente, regresiones, costo incremental y motivo de parada. Comparar entregables con tareas representativas; número de rondas, tool calls o tests agregados no son métricas de calidad por sí solos.
- Antes de habilitar una política de mejora como default, comparar en fixtures/tenants aislados resolución, regresiones, bloqueos falsos, costo y tiempo frente al comportamiento base. Retirar la política si sólo agrega rondas/trabas; no ejecutar dos agentes con efectos sobre el mismo recurso para medirla. La cantidad de verificaciones no justifica degradar la capacidad de entregar.

Secuencia de habilitación: F0 inventario -> F1 núcleo/contratos y F2 presupuesto -> F3 control/wake -> F4a cloud/Git y F4b entorno/memoria -> F5 children -> F6 expansión. El desarrollo de F1/F2/F4a puede solaparse; no habilitar capacidad dependiente antes de su invariante. Una corrección aislada bajo contratos vigentes no necesita esperar a todas las funcionalidades.
F1 debe incluir el adaptador para que un requerimiento en modo harness cree/reutilice su `instance_plan` mínimo al activarse, sin exigirlo en directo. No asumir que la sesión cron actual ya es plan-driven sólo por compartir `processAssistantTurn`. Plan de pasos amplios sí; nueva jerarquía de microsteps automáticos no.
El detalle de tablas/nombres queda en F0, pero deben existir antes de rollout contratos de identidad, modalidad, definición del run, presupuesto, espera/wake, resultado/evidencia y autoridad de archivos. Versionar campos de forma aditiva; no añadir nuevos estados a enums consumidos sin adapter compatible.

## 7. Alcance de la verificación documental

Esta auditoría revisa coherencia de diseño y rutas de código; no verifica disponibilidad del proveedor, políticas económicas aún no acordadas ni implementación de A01-A47. El plan principal registra resultados históricos del baseline por separado.
Al editar ambos documentos: comprobar referencias locales, numeración única A01-A47/D1-D7/V1-V6/R01-R16, ausencia de contradicciones sobre Git/sandbox/modalidad/mejora, límites de tamaño y `git diff --check`. No ejecutar builds, migraciones, creación de repos o tareas live sólo para validar estos Markdown.