# Plan de simplificación del harness: autonomía, continuidad y entorno gestionado

Fecha: 2026-10-28. Estado: **implementación parcial local iniciada; fases completas pendientes**. Evidencia y límites: [primer incremento](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_IMPLEMENTATION_2026-10-28.md).
Base API examinada: `2545ee69a811379dbf7496b802e3a0857b5a9d34`.
Este documento no acredita cambios, migraciones, recuperación de sesiones ni despliegues en producción.
Las decisiones más recientes del usuario prevalecen sobre propuestas anteriores de esta conversación.
Revisión de consistencia: 2026-10-28. Casos, decisiones abiertas y contratos auditados: [anexo de validación](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_VALIDATION_2026-10-28.md). Corregir el diseño no acredita implementar sus garantías.

## 1. Objetivo y decisiones de diseño

**Usuario pide, el agente aclara lo indispensable, planea, ejecuta y entrega. El harness estandariza, ayuda y mantiene el ambiente; no prescribe cada decisión.**

- Mantener el núcleo en `instance/assistant`; no introducir otro motor ni sustituirlo por un SDK externo de agentes.
- Dos modalidades sobre el mismo núcleo: **directo** para atender peticiones sin ciclo de plan y **harness** para continuar un `instance_plan` hasta una conclusión positiva o negativa. Modalidad no cambia catálogo ni permisos.
- Alcance de producto: una instancia sin requerimiento o dedicada a un único requerimiento. No introducir selector multi-requerimiento ni reutilizar automáticamente una instancia vinculada para otro requerimiento.
- Conservar workflows, `instance_plans`, steps, relaciones, resultados y consumidores existentes.
- Un step lógico debe poder resolver una petición completa de principio a fin, mediante planificación, múltiples turnos, herramientas y subflujos autorizados, sin una trayectoria técnica prefijada.
- No confundir el step lógico del producto con un `use step` del SDK o con el tiempo máximo de una función.
- La planificación es deseable: proporcional al trabajo, revisable por el agente y ejecutable sin aprobaciones administrativas repetitivas.
- Capacidad inherente de mejora iterativa sobre steps/planes: por petición del usuario o política del loop, revisar y perfeccionar implementación/integración dentro de alcance y presupuesto, sin gates universales ni repetición ciega de efectos.
- Antes de trabajar, preguntar si el contexto carece evidentemente de información indispensable para ejecutar correctamente.
- Durante la ejecución, favorecer que el agente investigue, pruebe y cambie de camino dentro de su alcance y presupuesto.
- Gestionar entregables con `edit_cloud_file` sin sandbox. Buscar archivos del workspace puede provisionarlo bajo demanda, también en conversación normal sin requerimiento ni ciclo cron.
- Usar un catálogo común de capacidades en conversación, requerimiento y workflow; no separar herramientas por estado de ejecución. Mantener permisos, bindings y contratos contextuales explícitos.
- En ambas modalidades el agente decide si necesita entorno: nunca se provisiona por defecto. Todo cierre de trabajo exige evidencia Git verificable (aplicación, documentos o informe de conclusión negativa), sin exigir preview ni sandbox.
- Presupuesto explícito del requerimiento; si no existe, fallback del 70% del crédito disponible. La semántica propuesta se detalla en la sección 8.
- Usar versión de contrato y hashes donde aporten compatibilidad e integridad; evitar una nueva maquinaria de reconciliación por cada cambio.
- Preservar autorización, aislamiento, cancelación, contabilidad y protección contra repetir efectos externos inciertos.

No objetivos: reescribir todos los workflows, soportar varios requerimientos por instancia, eliminar pruebas, aprobar automáticamente requerimientos, dar acceso global a producción, hacer que toda petición cree un plan, garantizar ejecución infinita o recuperación perfecta de cualquier efecto.

## 2. Evidencia: situación actual y evolución

| Área | Observado en el código o diagnóstico | Cambio buscado |
| --- | --- | --- |
| Núcleo | Requerimientos y runner de workflows ya llaman a contexto/turnos de `instance/assistant` | Conservar y simplificar los adaptadores, no crear otra inferencia |
| Continuación | El drainer excluye sesiones pausadas; un comando de reintento puede quedar esperando su reactivación por otra vía | Continuación canónica con resultado verificable |
| Errores | Fallos de comprobación, almacenamiento o auditoría pueden convertirse en pausa de reconciliación | Diferenciar interrupción técnica, fallo de tarea y efecto desconocido |
| Permisos | Error/timeout consultando autorización puede parecer una denegación real | Indisponibilidad recuperable sin conceder acceso por defecto |
| Memoria | `read_session_history` puede devolver recibos de anteriores lecturas; página demasiado grande puede no avanzar | Historial por referencia y contexto resumido |
| Duración | `exec` admite hasta 120 segundos, también con background; existen tramos y topes por ruta | Procesos y step lógico independientes del request |
| Entorno | Requerimiento prepara repositorio/workspace incluso si no necesita código | Entregables mediante archivos cloud sin VM; acceso a archivos del workspace provisiona sandbox bajo demanda, también desde chat normal |
| Resultado de workflow | Gates incluyen shape, criterios y comprobaciones de acciones/browser | Preservar contratos explícitos; retirar heurísticas universales que confunden herramienta usada con objetivo logrado |
| UI | Algunos botones cambian estados y anuncian inicio sin confirmar ejecución | Una operación de control y estados sustentados en eventos |

En el incidente examinado había 105 lecturas de historial frente a 10 búsquedas web; el último reintento estaba encolado y la sesión pausada por reconciliación. Se observaron timeouts de DB temporalmente próximos al error: correlación, no atribución concluyente de una consulta concreta. No reutilizar ese snapshot como autorización permanente para reparar.

Historia Git relevante:
- `69473709` (2026-02-17): el step añadía objetivo, instrucciones y expected output al asistente; buena referencia de simplicidad.
- Esa versión también podía completar un step al salir del bucle sin comprobar finalización: **no hacer rollback literal**.
- `8720d2a0` (2026-05-03): incorpora al prompt la cancelación de planes con steps genéricos.
- `bd426922` (2026-10-13): incorpora infraestructura del harness separado, después parcialmente retirada.
- `22e491cf` (2026-10-23): vuelve a compartir el núcleo del asistente y mueve el motor anterior a fixtures retiradas.
- Cambios posteriores corrigen presupuesto, importación de pausas y timeouts. Evitar reintroducir límites ya retirados.

Git acredita mecanismos y fechas, no que una versión tenga mejor resolución real. Comparar tareas representativas en ambientes aislados, nunca dos ejecutores con efectos sobre el mismo trabajo.

## 3. Propiedades objetivo del agente y del harness

Estas propiedades son requisitos de comportamiento futuros, no capacidades ya implementadas ni nombres de nuevas APIs. Definen qué experiencia construir sin depender de un producto externo como especificación.

| Propiedad | Comportamiento observable | Responsable | Aceptación |
| --- | --- | --- | --- |
| Resolución generalista de principio a fin | Una petición o step amplio puede investigar, producir, verificar y entregar; no se limita a una herramienta o microacción | Modelo + núcleo compartido | A03-A06 |
| Planificación proporcional y revisable | Construye un plan útil, lo ejecuta y lo adapta según resultados; no exige aprobación de cada cambio técnico | Modelo | A02, A04, A06 |
| Aclaración contextual | Pregunta antes de trabajo sustantivo si falta información indispensable y evidente; durante ejecución busca resolver lo investigable | Modelo + sesión | A01-A02 |
| Autonomía para corregir | Un error ordinario vuelve como información; puede corregir argumentos, editar, probar o cambiar de herramienta sin reiniciar el step | Modelo + herramientas | A06, A09-A10 |
| Herramientas claras y disponibles | Puede leer, buscar, editar, ejecutar, navegar y usar integraciones autorizadas; conoce capacidad real, errores y resultados | Catálogo + adaptadores | A03, A06, A20 |
| Instrucciones durante el trabajo | Recibe y conserva mensajes mientras está ocupado; los incorpora en puntos seguros sin crear un worker competidor | Admisión + runtime | A07 |
| Continuación natural | Pedir, continuar y reintentar reutilizan `instance/assistant`, con el mismo trabajo guardado y sin renovar presupuesto por accidente | Runtime | A08, A14 |
| Memoria útil y acotada | Trabaja con resumen, decisiones, plan y contexto reciente; recupera detalles por referencia sin releer recursivamente todo el historial | Memoria + modelo | A13 |
| Trabajo independiente del cliente | Cerrar la interfaz o agotar un tramo técnico no termina la tarea ni obliga a repetir instrucciones | Runtime + transporte | A04, A18 |
| Procesos independientes del turno | Un comando largo sigue activo y devuelve identidad, estado y logs consultables mientras el agente hace otro trabajo | Entorno gestionado | A11 |
| Recuperación y restauración diferenciadas | Reconecta el entorno y recupera archivos confirmados; distingue continuar, restaurar archivos y empezar otro intento | Entorno + control | A08-A09, A12 |
| Composición de subflujos | Ejecuta workflows autorizados cuando ayudan, integra sus resultados y mantiene presupuesto y cancelación de la tarea raíz | Modelo + runner | A15-A16 |
| Cierre útil dentro del presupuesto | Conserva resultados y entrega lo conseguido antes del agotamiento previsible, sin afirmar cumplimiento inexistente | Modelo + billing + entrega | A14-A15, A19 |
| Transparencia y control | Muestra progreso y esperas reales, acepta pausa/cancelación y distingue entrega del agente de aceptación formal | Producto + runtime | A05, A16, A18-A20 |

El harness mantiene el ambiente y la continuidad; el modelo decide la estrategia dentro del encargo. Un workflow explícito conserva su secuencia y contrato: autonomía dentro del step no autoriza saltarse condiciones del padre.
No se promete memoria perfecta, ejecución infinita ni restauración universal. Un checkpoint de archivos no revierte pagos, envíos, cambios en bases de datos o publicaciones, ni garantiza que procesos anteriores sigan vivos.
La confianza debe estar acotada al tenant, recursos y acciones autorizados. Una clasificación del modelo no es la única autorización de shell, publicación o acceso a datos. Los límites de recursos y las restricciones explícitas siguen vigentes, sin convertirse en procedimientos innecesarios para resolver la tarea.

## 4. Arquitectura y límites de responsabilidad

```text
Chat / requerimiento / disparador de workflow
        -> admisión durable y contexto autorizado
        -> instance/assistant: preparar contexto + processAssistantTurn
        -> herramientas / subflujos explícitos / entorno gestionado
        -> recibos, memoria, presupuesto y continuación
        -> respuesta y/o resultado del step para el runner existente
```

Es una separación de responsabilidades, no una propuesta de microservicios ni de nuevas tablas para cada concepto.
- Modelo: planear, investigar, seleccionar herramientas, verificar, corregir, decidir si necesita subflujos y describir el resultado.
- Workflow: decidir qué step corresponde, aplicar condiciones/ramas, consumir outputs y respetar el contrato definido.
- Runtime: admitir instrucciones, asegurar ownership, persistir resultados, continuar, contabilizar y cancelar.
- Entorno: conectar/provisionar recursos autorizados, mantener procesos/archivos, renovar credenciales y recuperar infraestructura.
- Producto: presentar progreso, presupuesto, entregables y revisión cuando exista.

Mantener endpoint y llamadas internas actuales. Los wrappers durables pueden delegar al núcleo compartido sin pasar por HTTP. Cron conserva su papel de admisión/recuperación; no se añade otro scheduler permanente como primera solución.

### 4.1 Modalidades convergentes
| Aspecto | Directo | Harness |
| --- | --- | --- |
| Entrada y alcance | Petición, edición, revisión o pregunta; sin iniciar ciclo de trabajo | Trabajo autorizado cuyo `instance_plan` conserva progreso y continuidad |
| Ejecución | El asistente usa tantos turnos/herramientas como necesite para la petición actual; no equivale a una única llamada LLM | El plan cicla el mismo asistente y sus steps amplios hasta conclusión, respetando ramas del workflow |
| Planificación | Puede elaborar/revisar un plan sin activarlo | Ejecuta y adapta el trabajo dentro del contrato; no modifica restricciones explícitas unilateralmente |
| Requerimiento | Vínculo contextual por instancia; leer/editar/revisar no activa ni reabre el ciclo implícitamente | Vínculo explícito del plan/run y atribución de progreso y presupuesto |
| Entorno y herramientas | Catálogo común; cloud files sin VM, workspace bajo demanda | Las mismas capacidades; ningún bootstrap de VM por entrar al ciclo |
| Cierre | Resultado de la petición con evidencia Git cuando entrega trabajo | Conclusión positiva/negativa y evidencia Git; aceptación de negocio sigue siendo independiente |

El modo directo también tiene ejecución durable y recuperación; «sin ciclo» significa sin activar la orquestación del plan. Pasar a harness requiere intención de ejecutar el plan, no detectar un requerimiento vinculado. Volver al chat no cancela trabajo activo: instrucciones se incorporan al owner y escrituras compartidas se serializan, sin segundo ejecutor competidor.
Persistir la modalidad de la petición/run en contexto confiable; ningún parámetro del modelo concede autoridad. Eliminar para peticiones directas el fall-through actual de `workflow.ts` que ejecuta un plan pendiente al terminar la conversación. Entradas explícitas de workflows y programaciones ya autorizadas mantienen su activación. Invocar un subworkflow desde directo no activa además el plan principal. Si harness está activo, atender lectura/revisión en su siguiente punto seguro; mutaciones compartidas pasan por su owner, no se rechazan ni lanzan otro escritor.
Resolver el vínculo único mediante `(site_id, instance_id)` autenticados y relaciones existentes, contrastándolo con el plan cuando exista. Sin vínculo, permitir petición directa y vincular el primer requerimiento explícito mediante admisión atómica. Una vez dedicada, la instancia conserva ese requerimiento también terminado: revisión no lo reabre ni inicia ciclo. Otro requerimiento usa otra instancia mediante el flujo de creación existente, no un selector dentro de la sesión. Separar resolución contextual de permiso para avanzar ejecución: el resolver actual centrado en abiertos debe adaptarse.
La unicidad es un objetivo a validar y hacer cumplir, no una garantía del esquema actual: hay rutas históricas que admiten múltiples asociaciones. Inventariarlas antes de añadir restricciones; serializar creación/asignación para impedir que dos requests vinculen requerimientos distintos. No elegir el último status ni borrar historial para resolver conflictos. Datos históricos ambiguos requieren reparación acotada y visible, no una nueva UX multi-requerimiento; el conflicto bloquea sólo atribución/efectos sobre ese vínculo, no obliga a reinventar el agente. Esto no prohíbe instancias históricas de reemplazo para el mismo requerimiento ni altera ownership ya establecido.
Continuar no significa insistir indefinidamente: información indispensable ausente espera respuesta, pausa/cancelación se respetan y límite económico provoca cierre parcial/negativo honesto. El modelo propone conclusión; el runner valida el contrato sin imponer una trayectoria de herramientas. Una respuesta intermedia o fin de tramo no es conclusión.

## 5. Step amplio y compatibilidad de workflows

### 5.1 Unidad de trabajo
Un step puede significar «investiga, construye y verifica este informe», no sólo «ejecuta una herramienta». Conserva su ID mientras planifica, realiza múltiples acciones, espera procesos y atraviesa tramos técnicos. Las recetas existentes siguen siendo válidas: ampliar el ejecutor no reescribe automáticamente los templates.

Separar step lógico, intento de negocio, tramo técnico y llamada a herramienta. Las rondas de mejora añaden identidad de revisión sin convertirse en retries de fallo. Un timeout de transporte no incrementa el retry de negocio ni dispara la rama de fallo.
No convertir `isDone` de una respuesta intermedia en finalización del step si queda trabajo necesario. El modelo presenta el resultado terminal por el contrato del runner.

### 5.2 Series de workflows y subflujos
- Permitir al agente invocar workflows autorizados como herramientas cuando ayuden al objetivo; no exigir delegación.
- Mantener parent run/step, child run, invocación estable, objetivo y referencias a outputs persistidos.
- Antes de crear un child, registrar la intención; ante respuesta perdida consultar esa invocación, no crear otro child.
- Todos los hijos heredan alcance, restricciones y presupuesto raíz. No obtienen otro fallback del 70%.
- Subworkflows y sus runs pertenecen al mismo trabajo raíz; no añaden un segundo requerimiento a la instancia ni cambian su vínculo. Conservar identidades/instancias de ejecución que ya requiera el runner sin ampliar la cardinalidad de producto.
- Un hijo no reasigna el step padre ni crea otro propietario de su workspace. Compartir archivos por referencias o acceso explícito; no compartir permisos implícitamente.
- Mientras espera hijos, el padre puede trabajar en tareas independientes o ceder el worker. Espera no equivale a fallo.
- Si el padre depende del hijo, persistir la espera y liberar su cupo/lease de ejecución; conservar identidad y recibos, no un lock que el hijo necesita. Transferir acceso mutable al workspace sólo en un punto sin efectos activos, o usar workspace aislado. El hijo guarda resultado antes del aviso; reconciliar avisos perdidos con el runner existente. Probar progreso con un solo cupo, recuperación del padre y ningún escritor simultáneo.
- Cancelación impide nuevas acciones en la descendencia y solicita parar las activas; registrar las que no son cancelables.
- Evitar ciclos de invocación y fan-out sin control con límites de recursos visibles. No usar profundidad/turnos como criterio de calidad del trabajo.
- Hijos fallidos retornan resultados al agente para elegir otra vía; la política explícita del workflow padre sigue vigente.

### 5.3 Contratos que no se rompen
| Contrato | Invariante y prueba requerida |
| --- | --- |
| Planes y steps | Conservar IDs, orden, relaciones, referencias de nodos y vínculos con requerimientos |
| Templates y runs | No mutar template al ejecutar; mantener materialización y ejecuciones previas |
| Outputs | Mantener `plan_result`, `actual_output`, `result`, shape e interpolación de outputs previos |
| Estado | No completar por timeout ni repetir completados como recovery; mejora autorizada crea revisión trazable sin borrar resultado anterior ni repetir efectos |
| Condiciones/ramas | Conservar success/failure/always, skipped y dependencias según definición |
| Retries | Respetar retry/recovery plan explícitos; separar reparación técnica de nuevo intento |
| Canales y nodos | Preservar pre-response sin envíos, dry-run, destinos, multi-output y límites de autorización |
| Herramientas | Conservar nombres/argumentos usados por workflows mediante adaptadores versionados |
| Ownership | Un ejecutor válido por unidad mutable; no ejecución competitiva chat/cron/workflow |

### 5.4 Resultado, evidencia y falsos positivos
Mantener validación de formato y obligaciones realmente declaradas. El modelo evalúa el objetivo y reporta limitaciones; recibos confirman operaciones, no la verdad semántica de todo el resultado.
Retirar por versión las heurísticas globales «debe usar cualquier herramienta», «debe usar exactamente esta vía» o validaciones de browser/código inferidas sin requisito explícito. Si el workflow exige una acción o evidencia concreta, conservarla.
Inventariar `requireToolExecution`, `requiredToolExecutions`, browser transitions, criterios y `result-gate` antes de cambiar defaults, incluyendo procedencia. Estar persistido en metadata no prueba que sea un requisito explícito: separar instrucciones autorizadas de heurísticas generadas. Retirar éstas bajo contrato versionado y pruebas de compatibilidad; no preservar gates accidentales para siempre ni borrar controles de seguridad/formato o exigencias reales silenciosamente.
Conservar `completed/failed/skipped` de `plan_result`. Un entregable parcial se guarda con alcance y limitaciones; no añadir `partial` al enum sin adaptar consumidores. Si no satisface el contrato, no activar falsamente la rama de éxito. Una petición libre puede entregar un resultado parcial sin presentarlo como cumplimiento formal.

### 5.5 Ciclos de mejora como capacidad del ejecutor
No es un tercer modo ni un agente juez obligatorio. Directo puede mejorar una entrega sin activar plan; harness puede iterar el step actual o revisar la integración entre steps mediante el mismo `instance/assistant`. El runner facilita continuidad, presupuesto, versiones y feedback; el modelo propone qué mejorar y cómo verificarlo.
- Disparadores: petición del usuario («mejora», «integra», «añade telemetría»); política del plan/workflow con objetivos de mejora; revisión autónoma pertinente antes de concluir. Un resultado funcional puede mejorarse sin declarar un fallo artificial.
- Política base: examinar el resultado frente al objetivo, detectar mejoras relevantes y realizables, ejecutar las seleccionadas y comprobar su efecto. Sin mínimo universal de rondas, score obligatorio ni obligación de usar una herramienta concreta. Las comprobaciones contractuales explícitas siguen vigentes.
- Cada ronda registra identidad estable, origen, objetivo, revisión base, steps/archivos afectados, evidencia y presupuesto remanente. La política define objetivos/alcance y límites opcionales explícitos; no scripts fijos que el modelo deba seguir para cualquier tarea.
- Flujo orientativo: implementar -> revisar resultado/integración -> elegir corrección útil -> aplicar -> verificar -> decidir continuar o entregar. Puede omitir una corrección si no aporta; no refactorizar por preferencia indefinidamente ni volver a evaluar la misma versión sin información nueva.
- Distinguir resultado funcional y candidato de mejora. Una ronda puede mejorar, no aportar, no aplicar, exceder presupuesto o necesitar información/acceso; son metadatos de revisión, no nuevos estados obligatorios de `plan_result` ni ramas de fallo ficticias.
- Antes del resultado terminal, las rondas viven dentro del mismo step amplio y se entrega un `plan_result` final. Después de una entrega, una mejora autorizada crea revisión/ejecución vinculada al step/plan original; no vaciar `completed`, borrar outputs ni alterar un run que otros consumidores ya usaron. Conservar IDs lógicos y el historial; representación mínima se define en F0.
- En mejora de plan, analizar interfaces y outputs entre steps, seleccionar el conjunto afectado y revalidar dependencias pertinentes. Puede ciclar un step, un conjunto o el plan completo cuando el objetivo/política lo justifique; no resetear automáticamente todos los estados ni repetir pagos/envíos/publicaciones/migraciones para «volver a probar». Steps ya terminados se revisitan mediante una revisión vinculada, incluso dentro de un plan aún activo. Los consumidores ya ejecutados conservan versión; nuevos consumidores reciben el candidato adoptado explícitamente.
- Separar construir/verificar una mejora de aplicarla a producción. Corregir código de un envío no autoriza reenviar; necesitar un deploy, migración o acceso externo nuevo se rige por la autorización vigente, no por la etiqueta «mejora».
- Guardar baseline y candidato. Si el candidato introduce regresión, corregir o descartar sus cambios aislados y conservar la última entrega válida conocida; no restaurar sobre ediciones concurrentes ni afirmar que un rollback de archivos revierte efectos externos. Adoptar por versión/CAS y evidencia disponible, sin prometer calidad perfecta.
- Telemetría es un objetivo de ingeniería pertinente: instrumentación, errores, métricas y trazas usando integraciones autorizadas y datos minimizados. No instalar servicios pagos, exportar PII/prompts/secretos ni ampliar tracking de personas por defecto. Validar localmente o con datos sintéticos cuando no hay autorización para tráfico real; faltantes no invalidan una implementación útil salvo obligación explícita.
- Mejoras durante el encargo comparten raíz y presupuesto; no incrementan `retry_count` ni crean otro fallback del 70%. Revisión posterior usa admisión D6, sin reset económico silencioso. Reservar margen para verificar y entregar, no sólo para seguir editando.
- Parar cuando se cumple objetivo sin mejora justificada, no hay avance verificable/nueva estrategia útil, se alcanza límite explícito, se protege margen de cierre o el usuario detiene. Una cantidad de rondas o enfoque de revisión expresamente solicitados se respetan dentro del presupuesto; no simular cambios para rellenar rondas ni omitir una revisión pedida sin explicar por qué. Informar pendientes; falta de ganancia no es un gate que pause todo. No reabrir una entrega automáticamente después del cierre salvo política de recurrencia previamente autorizada.
- Cada entrega mejorada fija manifest y evidencia Git de la revisión adoptada; candidatos descartados no reemplazan el ZIP/UI válido. Una revisión sin cambios referencia versión examinada y conclusiones; no inventar cambios/commits de código ni exigir commit por cada razonamiento intermedio.

### 5.6 Límite estructural para no recrear gates de calidad
La revisión produce observaciones y opciones para el modelo, no veredictos con autoridad. No recibe callbacks de cambio de estado, pausa, cancelación o rechazo de `plan_result`; no se conecta su score/resultado booleano a admisión, retries ni finalización. El modelo decide corregir, investigar o entregar con limitaciones; un reviewer separado es opcional y tampoco tiene veto.
Sólo autorización/aislamiento, cancelación, recursos y contratos explícitos de entrada/salida pueden restringir la acción o aceptación correspondiente. Incumplir una obligación real impide afirmar éxito, pero permite guardar el resultado y concluir negativamente; no exige consumir todos los intentos. Una sugerencia nueva no se transforma en requisito durante la ejecución.
Un test fallido informa un fallo observado; no poder ejecutarlo informa «no verificado», no «implementación fallida». No aplica también es un resultado válido. Ninguno de esos casos permite inventar cumplimiento de un criterio explícito; tampoco autoriza a una política de mejora a pausar globalmente el trabajo.
Revisar sobre versión concreta y volver a revisar cuando cambie el resultado o haya evidencia nueva. Prohibir ciclos revisión->rechazo->misma revisión sin acción útil. El límite es presupuesto/alcance y margen de cierre, no perfección universal. Una política opcional puede desactivarse sin tocar permisos, contrato del workflow ni continuidad; medir si realmente mejora resultados antes de volverla default.
La aceptación debe demostrar las dos direcciones: un camino alternativo válido puede terminar sin cumplir una receta accidental, y un resultado que incumple un contrato explícito no se declara exitoso. A44-A47 del anexo comprueban esta separación. La protección se implementa en la conexión entre componentes, no sólo como instrucción en el prompt.

## 6. Planificación, aclaraciones, prompt y herramientas

### 6.1 Política de trabajo
1. Leer objetivo, contexto disponible, restricciones, presupuesto y contratos relevantes.
2. Si falta información indispensable y evidente, hacer una pregunta concreta antes del trabajo sustantivo; agrupar dudas relacionadas sin formularios innecesarios.
3. No preguntar datos ya disponibles o investigables dentro del encargo. Preparar la pregunta no debe disparar provisión costosa innecesaria.
4. Planear proporcionalmente: una corrección pequeña necesita poco; un step amplio merece plan y checkpoints de progreso.
5. Ejecutar, observar resultados, revisar integración/calidad pertinente e iterar según 5.5. No pedir aprobación por cada revisión técnica reversible dentro del alcance; no exigir mejoras cosméticas ni agotar presupuesto buscando perfección.
6. Si aparece información faltante durante ejecución, investigar y resolver dentro de alcance/presupuesto. Preguntar sólo si requiere decisión del usuario, permiso o información no obtenible responsablemente.
7. No inventar hechos, destinatarios, credenciales o autorizaciones para evitar preguntar. Avanzar lo independiente cuando sea útil.
8. Entregar antes de consumir el margen de cierre, con lo logrado, evidencia disponible, faltantes y continuación sugerida.

### 6.2 Composición del prompt
Prompt base generalista + intención del usuario + requerimiento si existe + contrato del step si existe + contexto actual del ambiente + skills/instrucciones realmente aplicables.
Retirar cancelación por títulos genéricos, supuesto universal de programación, búsqueda obligatoria de skill ausente, layouts/frameworks/tests globales y obligación del modelo de administrar snapshots.
Conservar skills explícitas y reglas específicas del repo/workflow. No exigir razonamiento interno detallado en cada herramienta: solicitar propósito y progreso útiles.
El catálogo debe reflejar capacidades ejecutables, errores claros y alternativas. Cargar esquemas/contexto a demanda sin ocultar herramientas necesarias para recuperarse.
Archivos cloud/workspace, búsqueda, shell e integraciones comparten definiciones y adaptadores con independencia de que el requerimiento esté trabajando. La autorización se resuelve al ejecutar según actor, tenant, recurso y alcance; no según una etiqueta de «modo requerimiento». `plan_result` conserva su binding al step y no se inventa un plan para exponerlo en chat. Pre-response, dry-run, pausa/cancelación y destino autorizado siguen limitando efectos; catálogo común no significa permisos universales ni permitir al chat competir con un worker activo.
No imponer aprobación del plan como paso universal. Peticiones de «sólo analizar/planear» y restricciones explícitas de modo se respetan.

## 7. Continuidad, errores y UX

### 7.1 Admisión y control
- Persistir instrucción con identidad idempotente y orden antes de confirmar recepción; actualizar lo necesario en una transacción acotada.
- Si el worker está ocupado, aceptar la instrucción y despertarlo/señalizarla; nunca lanzar un competidor para atenderla.
- Consumir mensajes en límites seguros. Una instrucción «no publiques» revoca próximos efectos, pero no deshace lo ya enviado.
- `continuar/reintentar`: conservar archivos, memoria, presupuesto y efectos; restablecer sólo condiciones técnicas verificadas.
- `restaurar archivos`: acción distinta, con checkpoint y alcance explícitos; no revierte DB, pagos o publicaciones.
- `nuevo intento`: acción distinta y trazable; no renovar presupuesto ni borrar evidencia automáticamente.
- El vínculo con requerimiento no cambia automáticamente directo a harness; editar su definición o revisar una entrega no arranca el plan. Una orden explícita de ejecutar/continuar sí utiliza la vía canónica de activación.
- Respuestas a preguntas pendientes despiertan la misma tarea. Conversación completada no significa tarea completada.
- Todos los controles de UI usan el mismo servicio de control, no updates directos de status como señal de ejecución.

### 7.2 Tratamiento de fallos
| Situación | Acción |
| --- | --- |
| Argumento inválido, archivo ausente, patch conflict, test fallido | Resultado al modelo; corregir o elegir otra herramienta |
| Lectura/servicio temporalmente indisponible | Reintento acotado con backoff o feedback; mantener tarea retomable |
| Autorización no comprobable por outage | No ejecutar esa capacidad; distinguir de denegación y recuperar al volver el servicio |
| Denegación real | No bypass; alternativa autorizada o pregunta específica |
| DB/CAS/lease fallido | Detener efectos del worker inválido; recuperar desde recibos con propietario vigente |
| Escritura de resultado desconocido | Consultar estado por identidad y aislar esa operación; no repetirla ciegamente |
| Error de modelo recuperable | Reintento/compactación dentro del presupuesto sin borrar conversación |
| Tramo agotado | Checkpoint + siguiente tramo; no fallo del step lógico |
| Usuario cancela/pausa | No nuevos efectos; checkpoint posible y contabilidad de lo ya consumido |

Primero dejar al agente resolver errores ordinarios en su loop. Recuperación host sólo para transporte, persistencia, credenciales, ownership y recursos. No añadir un supervisor LLM obligatorio.
Auditoría de negocio y recibos deben ser durables; proyecciones de timeline/telemetría pueden reintentarse sin reejecutar la herramienta. Si hace falta outbox, reutilizar infraestructura existente o justificar una mínima cola transaccional.
UI proyecta: en cola, trabajando, recuperando, necesita información/acceso, pausado por usuario, terminado. Acompañar espera de motivo, responsable y última actividad. No prometer «started» por guardar un comando.

## 8. Presupuesto y entrega antes de agotar fondos

### 8.1 Política solicitada y semántica propuesta
Política de producto: presupuesto del requerimiento; fallback al 70% del crédito disponible cuando no exista. No aplica un nuevo límite arbitrario de tokens/turnos a la vida de la tarea.
Interpretación a confirmar: tomar el 70% una vez al admitir la tarea raíz, sobre crédito utilizable no comprometido; conservar ese techo en continuaciones. El 30% queda fuera del alcance de ESA tarea, no es una garantía de saldo mínimo de toda la cuenta ante otros trabajos.
Si se busca proteger siempre un 30% global, se necesita una política distinta de reserva de cuenta; no confundir ambas garantías.

- Con presupuesto explícito, respetar su remanente tras gasto previo; saldo de cuenta y reservas siguen limitando dispatch.
- Cero significa sin gasto autorizado. No interpretar cero como ausente.
- `null` actualmente desactiva el chequeo adicional en parte de la implementación. No reinterpretar silenciosamente datos históricos como fallback: versionar `explicit/fallback/legacy_unlimited` o semántica equivalente y migrar con decisión explícita.
- El presupuesto comprende modelo, herramientas cobradas, sandbox, compactación y subflujos atribuibles; no sólo tokens.
- Reintentar, cambiar worker o abrir un child no renueva el techo. Aumentos explícitos se registran como revisión.
- Ejemplo aritmético, no precio de producto: con 100 créditos utilizables y sin presupuesto, techo inicial 70; margen de cierre sale de esos 70, no de los 30 protegidos.

### 8.2 Concurrencia y contabilidad
Calcular admisión bajo compromiso atómico de cuenta, remanente compartido del requerimiento si existe y asignación raíz. No basta reservar cuenta: dos raíces del mismo requerimiento tampoco pueden comprometer dos veces su remanente. El compromiso no es un cargo y no debe duplicar reservas de modelo existentes.
Definir una sola autoridad de crédito libre: saldo utilizable menos compromisos pendientes y holds no contabilizados ya; auditar neteo de refunds y costo real. Reconciliar operaciones inciertas antes de liberar sus fondos.
Los hijos reciben subasignaciones del mismo presupuesto raíz; no presupuesto independiente ni doble atribución. Liberar compromiso no usado al terminar/cancelar de forma reconciliada.
Persistir `root_work_id` o identidad equivalente independiente del mensaje, instancia y tramo. Respuestas, ampliaciones durante trabajo, cambio directo/harness, retries e hijos conservan raíz y techo; cambio de modalidad no renueva fondos. Un encargo nuevo después de entrega requiere admisión nueva sin heredar accidentalmente operaciones del anterior; diferenciarlo de «continúa» según intención, aclarando sólo ambigüedad material. Recurrencias usan identidad estable `(schedule, occurrence)` para deduplicar. La política económica de nuevos encargos, revisiones y recurrencias queda en D6 del anexo; hasta resolverla no conceder presupuestos frescos automáticamente.
Una espera larga no monopoliza indefinidamente crédito: conservar techo/gasto de raíz, liberar sólo compromisos no despachados y volver a reservar al despertar sin recalcular el 70%. Si faltan fondos, espera económica visible, no permiso de sobregiro ni efectos nuevos. Evidencia pendiente retiene sólo fondos necesarios y permitidos para su cierre, no la reserva completa del trabajo ya terminado. Definir expiración/reanudación de compromisos junto con D4/D6.
Sustituir el chequeo de presupuesto sólo al inicio del ciclo por admisión por operación y control periódico de VM. Anticipar costo máximo razonable de la próxima operación; registrar gasto real después. No afirmar techo exacto si el proveedor puede cobrar después: medir y explicitar sobrepaso máximo tolerable antes del rollout.

### 8.3 Margen de cierre
Reservar dentro del techo una cantidad para guardar resultados, producir síntesis, publicar/verificar evidencia Git y entregar; dimensionarla con mediciones, no elegir un porcentaje oculto.
Antes de iniciar trabajo que invada ese margen, informar al modelo del remanente y pedir cierre útil. Permitir resumen/lecturas/entrega local necesarias, no nuevos subproyectos.
Mantener artefactos y progreso guardados durante ejecución; si proveedor o cuenta no permiten otra llamada, entregar un recibo determinista sin modelo con enlaces a lo persistido y limitaciones. Esto no garantiza una respuesta LLM bajo caída total del proveedor.
No gastar el margen protegido de cuenta ni enviar por un canal externo no autorizado para «asegurar entrega». La UI de la sesión debe poder mostrar la entrega persistida.

## 9. Entorno gestionado

### 9.1 Preparación y capacidades
- El harness ofrece herramientas remotas y archivos cloud sin sandbox; workspace vacío para ejecutar cálculos/procesos; checkout para un repo autorizado. Crear o editar Markdown no requiere VM. No selección por clasificador rígido: se prepara la capacidad solicitada por el agente o requerida por el workflow.
- Migrar `requires_sandbox`/browser del runner a capacidad/configuración lazy, no provisión incondicional previa al turno. Una acción browser explícitamente exigida sigue siendo obligatoria, pero provisiona al invocarla; un flag heredado no la inventa. Pre-response/dry-run mantienen prohibiciones. Consultar los hechos mínimos del manifest antes de crear; listar capacidades no asigna recursos.
- Publicar un manifest host-owned con workspace, versiones de runtime, herramientas instaladas, procesos, servicios/previews, repositorios y capacidades disponibles. Sólo nombres de conexiones/variables autorizados; nunca valores secretos.
- Imagen base versionada y comprobada. Detectar configuración del proyecto y permitir instalar dependencias dentro del aislamiento; paquetes del sistema requieren un mecanismo host autorizado, no acceso al host de producción.
- Provisión idempotente: asignación de identidad antes de creación, consulta por esa identidad ante timeout, sin duplicar recursos cobrados.
- Credenciales de plataforma quedan fuera de VM/argv/logs. Inyectar o intermediar sólo credenciales del proyecto y renovar las temporales. No usar tokens alternativos más amplios como fallback automático.
- Configurar navegador, DNS, HTTPS, descargas, adjuntos, puertos y previews según capacidades reales. Mantener aislamiento de metadatos/red privada; excepción de localhost del propio workspace no autoriza redes de otros tenants.
- Auth/billing del proveedor de sandbox es incidente de plataforma. Acceso faltante al repositorio o servicio del cliente puede requerir una solicitud concreta al usuario.

### 9.2 Procesos y servicios
Separar timeout de RPC, timeout de espera de resultado, vida del proceso y vida del step lógico. Un proceso background puede seguir aunque el worker ceda el turno.
Persistir process ID, workspace generation, propósito, comando protegido, timestamps, estado y referencia de logs. Polling acotado o evento de finalización despierta continuación sin bucle intensivo del modelo.
Logs por páginas y tamaño máximo de respuesta, con contenido durable cuando se promete conservación. Limitar CPU, RAM, disco y concurrencia de forma explícita y medible.
No suspender una VM sólo porque acabó un tramo si aloja procesos necesarios. Suspender cuando no haya trabajo activo o por política de presupuesto/cancelación. Respetar máximos reales del proveedor.
Después de restaurar archivos no afirmar que un proceso sigue vivo. Reconectar si existe; en caso contrario reportar interrupción y dejar al agente reiniciarlo sólo si es seguro.

### 9.3 Persistencia y restauración
Persistir archivos útiles, incluidos binarios/CSV/PDF/imágenes, no sólo texto en Git. Excluir secretos y documentar políticas de retención/cuota antes de prometer conservación.
Checkpoints incrementales con manifest/hashes, versión del ambiente y última captura confirmada. Separar backup privado, evidencia Git y deploy: no prometer ausencia de CI salvo en destinos/refs con integraciones desactivadas o exclusión comprobada. Publicar cambios en repo de aplicación conserva sus efectos autorizados y explícitos.
Restauración: conectar recurso vigente -> reanudar -> snapshot verificado -> reconstruir desde archivos/manifest -> informar pérdida concreta. No restaurar un recurso de otro owner ni resetear contenido sucio silenciosamente.
Ante captura fallida, conservar último checkpoint y retry técnico; si continuar pone en riesgo trabajo no persistido, comunicar estado degradado y guardar alternativas, no fingir durabilidad.
Reutilizar adaptadores actuales del workflow y sandbox; unificar backend progresivamente sin cambiar nombres/argumentos de herramientas usadas por templates.

### 9.4 Entregables cloud y provisión desde herramientas de archivos
Decisión: separar documentos persistentes de filesystem ejecutable. `edit_cloud_file` es una herramienta nueva propuesta, no implementada por este documento; los nombres de lectura/búsqueda siguientes describen contratos a definir sin romper herramientas existentes.

| Operación | Comportamiento | ¿Provisiona sandbox? |
| --- | --- | --- |
| `edit_cloud_file` | Crear o editar entregable textual privado, versionado y vinculado a la instancia | No |
| Leer/buscar archivos cloud | Consultar entregables/adjuntos autorizados por ID, nombre o contenido con paginación | No |
| Buscar/listar/leer archivos del workspace | Resolver el workspace autorizado, conectar/reanudar o crear si es nuevo y ejecutar la operación | Sí, cuando hace falta |
| Ejecutar comandos o editar filesystem | Usar el mismo resolver y workspace; no exigir buscar un archivo como ceremonia previa | Sí, cuando hace falta |
| Importar/exportar entregable | Copiar una versión cloud al workspace o publicar una revisión del resultado al almacenamiento privado | Sólo el lado workspace lo necesita |

**Contrato propuesto de `edit_cloud_file`:** acciones `create`, `replace` y `patch`; nombre/MIME y contenido UTF-8 para crear, `file_id` y `expected_version` para editar, cambios exactos y acotados para patch. La clave de operación la fija el host. Respuesta durable con `file_id`, versión, hash, tamaño, estado y referencia de visualización/descarga autenticada; no devolver sólo texto o una URL temporal como identidad.
Repetir una operación confirmada devuelve su recibo. Edición sobre versión obsoleta devuelve conflicto y la versión vigente; el agente relee y corrige, no sobreescribe cambios concurrentes. Confirmar metadata/versión sólo después de persistir el objeto; ante timeout recuperar por identidad y limpiar objetos huérfanos sin borrar versiones confirmadas.
Alcance inicial: Markdown, texto, CSV y JSON como documentos; no edición arbitraria de PDF/Office/binarios mediante patches de texto. Los binarios se almacenan como entregables por importación/exportación y conservan MIME/hash; generación/conversión usa herramientas o workspace sólo cuando haga falta. Renderizar Markdown/HTML como contenido no confiable, sin scripts activos.
El sitio, actor, instancia y autorizaciones provienen del contexto confiable. `requirement_id`, plan y step son vínculos opcionales: nunca requisitos para escribir un documento. Lectura/descarga no exige lease de una ejecución cron; escritura sí exige operación y permisos vigentes. Archivo privado por defecto, cuotas/tamaño/paginación y URLs firmadas o acceso autenticado; no publicación pública implícita.
Buscar en cloud no busca en filesystem ni arranca VM. Si se usa una sola herramienta de búsqueda, debe declarar `source=cloud|workspace`; si se usan herramientas separadas, su nombre y descripción deben hacer esa diferencia inequívoca. Sin repo vinculado se puede provisionar workspace vacío; no inventar un checkout ni interpretar «no hay archivos» como fallo. Si el objetivo menciona un repo ambiguo, aclararlo antes de crear/copiar recursos.

**Disponible en el asistente normal:** registrar cloud files y wrappers lazy del workspace en el catálogo común de `instance/assistant`, no sólo en tools adjuntas por `requirement-runtime` o workflows. El wrapper resuelve handle al ejecutar; no requiere tener un sandbox para construir el catálogo. Listar/describir herramientas no provisiona recursos.
Resolver idempotente por tenant y ámbito de trabajo: reutilizar binding autorizado de conversación, requerimiento o workflow; conservar el aislamiento ya definido para runs. Dos búsquedas concurrentes no crean dos VMs. Un chat adjunto a trabajo activo no toma su ownership por consultar archivos; compartir lectura donde sea seguro y serializar escrituras mediante el propietario vigente.
Llamar la herramienta de archivos del workspace expresa intención de usar esa capacidad y muestra preparación/costo en eventos, sin preguntar por una VM cada vez si ya está autorizada. Comprobar permisos y presupuesto antes de crear; el chat normal usa su presupuesto raíz/fallback, no crea un requerimiento ficticio ni renueva presupuesto por tool call.
El resolver conecta -> reanuda -> provisiona si es workspace nuevo. Para uno perdido con trabajo previo, aplica restauración de 9.3, no reemplazo vacío. Un fallo del sandbox no impide editar/entregar documentos cloud; una caída de storage no autoriza declarar que se guardaron.
No montar/sincronizar automáticamente todos los entregables. Import/export explícito conserva `file_id`/versión/hash y detecta conflictos, sin sobrescribir la versión cloud con un checkout viejo. La retención de documentos es independiente del TTL de la VM.

**Reutilización a evaluar:** `show_artifact` actualmente registra enlaces a pantallas en `instance_artifacts`, no edita documentos. `read_document` ya lee documentos externos; ampliar con resolución de IDs autorizados, sin convertir URLs arbitrarias en acceso interno. `harness_artifacts` guarda recibos ligados a sesión/owner: no relajar ese fencing para convertirlo en biblioteca mutable. Reutilizar infraestructura privada de storage y presentación con metadata/versiones propias sólo donde los contratos encajen.

### 9.5 Commits de entregables sin sandbox y continuidad de la UI
Contrato objetivo: `edit_cloud_file` guarda una revisión durable y genera su evidencia mediante la Git Data API del proveedor, sin clone, filesystem local ni shell. La publicación puede agrupar un lote lógico, pero no es opcional al cerrar trabajo. Ya existe uso de trees/commits/refs remotos en `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/requirement-checkpoint.ts`; extraer/reutilizar el mecanismo, no sus dependencias obligatorias de sandbox, branch de requerimiento o lifecycle.

- Unidad de commit: edición lógica confirmada (o lote explícito de archivos), no cada fragmento de streaming. Sin cambios de contenido, devolver unchanged y reutilizar la versión.
- Guardar relación `file_id` + versión + hash de contenido + destino Git autorizado + path + commit SHA. Versión de archivo y SHA de commit son identidades distintas: un commit puede contener varios archivos.
- Repo/ref/path se resuelven en el host con scope de tenant/instancia; no aceptar un destino arbitrario del modelo como autorización. No exigir un requerimiento para asignar almacenamiento/versionado documental.
- Leer base -> construir blobs/tree preservando otros archivos -> crear commit con parent conocido -> registrar intención -> actualizar ref sin force -> verificar resultado y persistir recibo. Serializar escritores propios por ref y detectar conflictos de versión; fast-forward no equivale a un CAS general sobre SHA esperado.
- Ante timeout consultar SHA/ancestría e intención guardada antes de reintentar; no duplicar commits confirmados ni sobrescribir cambios de otro writer. No rebasar automáticamente una edición conflictiva del mismo archivo como si fuera equivalente.
- Para documentos cloud, su revisión es fuente del contenido y Git evidencia vinculada; para código de un repo, mantener su línea de versiones y reconciliar worktree/remote mediante el adapter, no convertir toda aplicación en documento mutable. En ambos casos fijar las versiones exactas del entregable y derivar Git/archive del mismo manifest, no del «latest» mutable. Sincronización `pending/committed/conflict/failed`; no introducir dos escritores canónicos en paralelo ni declarar commit confirmado antes de verificarlo.
- Los commits documentales van a un destino privado sin integraciones de despliegue/CI activas, o con exclusión de esas refs comprobada. `[skip ci]` no garantiza que no haya deploys/webhooks. No reutilizar por defecto la rama desplegable de una app para informes.
- Antes de habilitar F4a, configurar un destino Git documental gestionado por plataforma y vinculado al tenant, sin exigir repo al usuario ni VM. Selección física/permisos/capacidad se validan en V6 del anexo; un repo público nunca es fallback de documentos privados. No dar acceso directo a un repo compartido entre tenants. Autorizar contenidos, tree, versiones, diffs y descargas; binarios grandes quedan en storage con versión/hash referenciados desde Git.
- Restaurar una versión crea una nueva revisión/commit; no resetea historia compartida ni revierte efectos externos.
- Cada conclusión de trabajo, positiva o negativa, referencia repo autorizado, commit SHA, paths y versiones/hashes. Aplicación: archivos y resumen verificables; investigación/revisión: documentos; imposibilidad: informe honesto con intentos, límites y resultados parciales. No fabricar cambios de aplicación ni pruebas para producir un commit. Un resultado sin cambios puede referenciar commit previo más un informe de evaluación cuando corresponda.
- «Siempre evidencia Git» se aplica al cierre del trabajo, no a cada pregunta, acuse o mensaje intermedio. No iniciar VM ni exigir un commit para pedir datos faltantes. Cancelación abrupta conserva lo ya persistido y evidencia pendiente sin prolongar acciones contrarias al stop; no prometer commit si faltan acceso, fondos o proveedor.
- Persistir por separado resultado del trabajo, evidencia y entrega. Aceptar `plan_result` según su contrato y guardar resultado terminal aunque Git esté indisponible; liberar worker/lease/VM y compromisos sobrantes. Mostrar «trabajo terminado; evidencia pendiente», nunca «ejecutando» o «entrega íntegra confirmada». La entrega íntegra requiere Git confirmado, no otro ciclo del agente. Un adaptador/cola del runtime existente publica con backoff y reconcilia por operación; no reactivar steps ni romper ramas por fallo de Git. Consumidores de SHA esperan referencia válida; ramas independientes continúan. Fallo persistente asigna incidencia a plataforma y próxima acción visible; D7 define resolución final sin fingir cumplimiento.
- Capturar evidencia sólo del trabajo autorizado y con minimización de datos; no copiar chats completos, secretos, cookies ni datos de terceros innecesarios a historia Git. Borrado lógico no elimina Git history: retención/eliminación y acceso histórico se deben comprobar en V6. La misma revisión inmutable alimenta ZIP/UI y commit; cache por tenant+revisión, y ediciones sobre versión anterior retornan conflicto.

**UI existente, comprobada:** ya soporta archivos de repositorio sin preview desplegado. `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/robots/use-browser-workspace.tsx` acepta `source_code` y usa ZIP en `source_code`/`repo_url` como fallback sin `preview_url`; `hasRequirementPreview` incluye fuente aunque su nombre sugiera sólo preview. `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/robots/robots-workspace.tsx` muestra `ZipViewer`, que ofrece árbol, lectura/edición de texto y envío de cambios al agente. `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/components/applications/CodeExplorer.tsx` reutiliza el mismo visor sin exigir preview. **No construir otro visor ni exigir despliegue para documentos.**
El contrato del visor es un archivo ZIP/TAR accesible, no una URL HTML de repositorio/commit: `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/components/simple-messages-view/components/use-archive-contents.ts` descarga y descomprime el contenido; no navega la Git API. Un `repo_url` normal por sí solo no activa el panel source de robots, aunque la lista de repositorios permite abrirlo externamente. Generar/servir un archive privado por revisión desde cloud storage o el commit sin sandbox y reutilizar el visor y sus controles existentes.
Cambios mínimos para chat normal: `latestSourceCodeUrl` retorna null cuando no hay `requirementStatuses`, antes del fallback a `instance_artifacts`; corregir la selección por instancia sin fabricar estados de requerimiento. Mantener tenant scope, descarga autenticada/proxy compatible, refresh por revisión y referencias `file_id`/versión en cambios enviados al agente. No reenviar contenido obsoleto como escritura sin conflicto.
Historial Git no implica que ya exista selector de commits/diffs en el visor: conservar la UI base; añadir esos controles sólo si se requieren como funcionalidad explícita. Distinguir «guardado», «versionado en Git» y «desplegado». Para entregables con source/archive ya conectado, no se necesita rediseño frontend; las adaptaciones corresponden a nuevas fuentes documentales y conversaciones sin requerimiento.

## 10. Memoria, versión y persistencia mínima

Mantener un historial canónico append-only o equivalente paginado; snapshot operativo pequeño con cursor, resumen, últimas interacciones, estado de operaciones y referencias de artefactos. Evitar copiar resultados de `read_session_history` dentro de resultados anidados.
Compactar antes del overflow, preservando objetivo, preguntas/respuestas, restricciones, plan vigente, resultados, pendientes y presupuesto. El resumen es una ayuda falible, no reemplaza recibos ni autoriza efectos.
Retener detalles recuperables por ID, búsqueda y páginas que avanzan. Medir tamaño serializado final, incluido escaping; un mensaje grande debe ser accesible por fragmentos, no devolver cursor idéntico sin explicación.
Mantener datos de razonamiento del proveedor sólo como exige el protocolo, no copiarlos a resúmenes ni exponerlos como progreso del usuario.

Control de compatibilidad simple:
- `contract_version` o equivalente para snapshot/runtime/resultado y reglas de lectura/migración explícitas.
- Fijar versión/hash de la definición materializada de cada run; editar template no modifica un run activo. Instrucciones compatibles pueden aplicarse en punto seguro; cambios de grafo, outputs o permisos requieren revisión explícita/nuevo run conservando evidencia. No mezclar un child activo o outputs ya consumidos con otro contrato. Hash detecta cambio; no decide equivalencia semántica ni bloquea por diferencias cosméticas.
- Fijar una definición no congela autorización: revocaciones de acceso, pausa/stop y reducciones de alcance se comprueban antes del siguiente efecto. Nunca diferir una revocación hasta terminar el run ni usar una versión antigua como permiso vigente.
- Hash de archivos para integridad/conflictos, no como aceptación semántica.
- Reutilizar CAS/versiones/leases existentes. Hash de contenido no reemplaza exclusión concurrente ni autorización.
- Deploy compatible no reinicia la tarea. Versión incompatible conserva estado, drena el owner anterior y aplica migración probada; nunca borra sesión por mismatch.

Datos lógicos requeridos (nombres físicos por decidir en revisión de esquema): identidad de tarea raíz, instrucción/cursor, step/intento/tramo, versión de contrato, presupuesto/compromisos, operación/recibo, parent-child y workspace/checkpoint.
Preferir columnas/estructuras existentes donde el contrato lo permita. Crear tablas sólo si son necesarias para historial/artefactos paginados o invocaciones durables; no una tabla por estado ni por incidente.
F0 entrega una matriz invariante -> fuente canónica -> operación atómica -> lectores/escritores -> migración. La unicidad reside en el binding vigente, no en `requirement_status` append-only; conservar múltiples status/runs del mismo requerimiento. Elegir representación para modalidad, raíz/ocurrencia, espera de child y evidencia sin añadir estados incompatibles a los enums de steps existentes. No implementar reglas sólo en el resolver dejando otros escritores sin control.

## 11. Mapa de implementación y consumidores

Rutas absolutas de esta checkout; antes de editar confirmar imports, esquema desplegado y guía Next instalada. Las rutas siguientes existen salvo donde se indica trabajo conceptual; no son APIs nuevas prometidas.

| Componente | Archivos/raíces | Trabajo |
| --- | --- | --- |
| Entrada/control | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/route.ts` y `user-message-log.ts` en ese directorio | Admisión idempotente, mensajes durante ejecución, controles reales |
| Núcleo | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/assistant-context.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/assistant-turn-core.ts` | Contexto compuesto, feedback y continuidad compartidos |
| Wrappers/planes | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/workflow.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/plan-steps.ts` | Conservar interfaz durable; step amplio y prompt generalista |
| Requerimientos | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/requirement-runtime.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/requirement-execution-boundary.ts` | Pausas técnicas, memoria, recibos y presupuesto |
| Vínculo contextual | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/requirement-context.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/plan-ownership.ts` | Resolver único requerimiento por instancia; prevenir doble asignación, reparar conflictos históricos y separar revisión de activación |
| Workflow runner | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/workflow-robot/run-plan.ts` | Step lógico continuo, subflujos y separación de retries técnicos |
| Contratos workflow | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/workflow-robot/plan-result.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/workflow-robot/result-gate.ts` | Preservar shape/consumidores, versionar retirada de heurísticas |
| Entorno compartido | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/workspace.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/workspace-tools.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/workflow-robot/sandbox-workspace.ts` | Provisión lazy, procesos duraderos y recuperación |
| Entregables cloud y catálogo | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/utils.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/agents/tools/show_artifact/core.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/agents/tools/read_document/core.ts` | Añadir `edit_cloud_file` y acceso documental sin VM; wrappers workspace disponibles en conversación normal |
| Permisos/router | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/agents/tools/router/screen-access.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/agents/tools/router/assistantProtocol.ts` | Separar outage/denied, preservar ejecutado/no ejecutado |
| Billing | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/robots/instance/assistant/requirement-billing.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/services/billing` | Compromisos raíz, margen de cierre, costo atribuible sin doble cargo |
| Cron/SQL | `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/app/api/cron/requirements-apps`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/API/supabase/migrations` | Recuperación segura en scheduler existente, equidad y migraciones aditivas |
| UI | `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/robots/instance-header.tsx`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/requirements/[id]/requirement-detail-actions.ts`, `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/app/components/simple-messages-view/hooks` | Sustituir updates directos por control, estado observable y entrega |

Los workflows de canales y rutas especializadas fuera de este alcance no se redirigen indiscriminadamente al agente generalista. Inventariar sus llamadas compartidas y preservar permisos/modos antes de modificar contexto/tools globales.

## 12. Fases y unidades entregables

Cada fase produce código, pruebas conectadas, nota de migración y evidencia de aceptación; una suite verde no sustituye la prueba real. No se fijan fechas sin estimación después del inventario.
Desarrollo no equivale a habilitación: F1 puede implementarse con límites actuales y fixtures; su autonomía prolongada se habilita después de F2 y de las piezas necesarias de F3/F4. F4a documental puede desarrollarse en paralelo; escrituras sobre trabajo activo requieren F3. Cada incremento lleva su propia migración y pruebas; F6 expande/retira, no descubre por primera vez la compatibilidad. Resolver decisiones sólo antes de habilitar lo que afectan, sin bloquear todo el proyecto por retención o política económica pendiente.

### F0 — Baseline y contratos (prerrequisito de todo)
- Inventariar consumidores de contexto/turnos, herramientas y resultados; capturar templates reales saneados con fixtures sintéticas.
- Verificar cardinalidad de vínculos por instancia en datos y rutas de creación; definir admisión atómica y reparación histórica sin selector multi-requerimiento ni reasignación silenciosa.
- Medir una petición simple, un requerimiento amplio y un workflow con ramas; registrar tiempo, costo, entregables y pausas técnicas.
- Confirmar versiones desplegadas, migraciones y límites del proveedor; asignar D1-D7/V1-V6 del anexo a su incremento, con política actual mientras no se autorice cambiarla.
- Entrega: matriz de compatibilidad ejecutable, invariantes de persistencia, activación explícita de modalidades y diseño de presupuesto/raíces/destino Git.
- Aceptación: reproducir el bloqueo de reintento y conservar ejecuciones/outputs actuales de workflows sin mutaciones de producción.

### F1 — Step amplio, prompt y aclaraciones (depende de F0)
- Separar step/intento/tramo; persistir continuación por turno, no sólo al agotar el lote.
- Establecer directo/harness según 4.1, mismo núcleo/tools y vínculo contextual; no activar plan por asociación histórica ni requerir uno para peticiones directas.
- Al activar harness de un requerimiento, crear/reutilizar un `instance_plan` mínimo con steps amplios y conectarlo al ciclo actual; el runtime de requerimientos actual no se vuelve plan-driven sólo por compartir turnos. Conservar IDs/steps previos y no crear microsteps artificiales.
- Mantener wrappers/exports y resultado del runner; simplificar prompt y retirar heurísticas en contrato nuevo, sin modificar templates antiguos implícitamente.
- Implementar contexto/política de mejora de 5.5 en steps amplios: baseline/candidato, objetivos, decisión de seguir/entregar y separación respecto de retry. Incluir revisión explícita de steps/planes ya entregados sin mutar ejecuciones históricas; habilitar con presupuesto, control y persistencia de F2-F4.
- Separar observaciones de mejora de controles de admisión/resultado según 5.6; comprobar imports/call sites productivos para que ningún gate retirado siga siendo llamado por un wrapper. Reutilizar validadores de shape/permisos, no la agregación de heurísticas con veto.
- Permitir buena planificación y corrección autónoma; pregunta inicial cuando falta información indispensable.
- Entrega: un step realiza investigación, ejecución y verificación en varios tramos sin disparar failure por timeout.
- Aceptación: mismo contrato de salida, sin replay de completados como recuperación; revisiones de mejora trazables, sin cancelación por título genérico ni obligación de escribir código.

### F2 — Presupuesto raíz y cierre útil (depende de F0; antes de habilitar autonomía prolongada)
- Implementar explícito/fallback, compromisos concurrentes, costo raíz e hijos y margen de cierre.
- Fijar frontera de raíz/ocurrencia y atribución de revisiones según D6; admisión conjunta cuenta+requerimiento+raíz y re-reserva sin nuevo 70% después de espera.
- Conservar contabilidad existente y adaptar chequeo por ciclo a admisión efectiva por operación; resolver `null` histórico mediante migración versionada.
- Entrega: cálculo y reservas transaccionales con pruebas de concurrencia reales, aviso al agente y entrega sin modelo de emergencia.
- Aceptación: dos tareas no comprometen el mismo saldo; retry/child no renueva presupuesto; salida parcial disponible antes de agotamiento previsible.

### F3 — Entrada y continuación unificadas (depende de F1 y F2)
- Admitir mensajes aunque ocupado; consumo ordenado, control stop/pause/continue e idempotencia de dispatch.
- Definir wake durable para directo, plan y requerimiento; timeout/respuesta/fin de child no dependen de que exista una fila de requerimiento. Extender el dispatcher/cron existente que corresponda con trabajos debidos y deduplicación; no asumir que el cron de requerimientos ya recupera chats o evidencia. Evento perdido se reconcilia desde estado persistido, sin sondeo LLM continuo.
- Eliminar deadlock de reintento sobre pausa técnica clasificada; no borrar holds manuales ni operaciones inciertas.
- Separar fallos ordinarios que resuelve el agente de fallos host; proyectar recuperación en UI sin falsos started.
- Aceptación: reintentar una sesión recuperable produce acción útil sin script; instrucciones concurrentes y pérdida de respuesta no duplican efectos.

### F4 — Entorno y memoria durables (depende de F1/F2; puede desarrollarse en paralelo con F3)
- F4a: entregar primero `edit_cloud_file`, lectura/búsqueda cloud, presentación privada y catálogo del asistente normal. No esperar a resolver procesos largos para eliminar VMs destinadas sólo a informes.
- Añadir evidencia Git obligatoria y adapter/cola de publicación en el runtime existente; terminalizar ejecución y liberar recursos aunque falte Git, manteniendo entrega/evidencia diferenciadas según 9.5. Destino privado gestionado y manifest común para commit/ZIP son prerrequisitos de habilitación, no un repo que el usuario deba configurar.
- F4b: acceso lazy a archivos del workspace desde chat/requerimiento/workflow con provisión idempotente, presupuesto y operaciones import/export versionadas.
- Workspace sin repo, manifest, procesos de larga duración, red/browser y credenciales con ámbito correcto.
- Historial paginado, compactación persistida, artefactos por referencia y captura/restauración de entregables.
- Unificar backend de entorno mediante adaptadores para tools de workflows existentes.
- Aceptación: proceso >120 segundos, varios cambios de worker/contexto, pérdida de VM y recuperación verificada, sin perder archivos confirmados.

### F5 — Subflujos dentro del step (depende de F2-F4)
- Invocación autorizada de workflows, identidad parent-child, espera/reanudación, outputs, presupuesto heredado y cancelación.
- Padre esperando libera recursos que necesita el hijo; persistir resultado y wake reconciliable. Aceptación obligatoria con un cupo, workspace compartido y caída entre resultado y notificación.
- El agente puede ejecutar una serie de subflujos y evaluar el conjunto sin cambiar el grafo contractual del padre.
- Aplicar revisión de integración a resultados de hijos y steps relacionados; ciclar el alcance de mejora autorizado con versión nueva, parcial o completo, sin repetir los efectos del grafo por defecto.
- Aceptación: child dispatch ambiguo no crea duplicados, fallo de un hijo admite alternativa autorizada, cancelación y costo abarcan descendencia.

### F6 — Rollout y retirada (depende de todas las anteriores)
- Completar pruebas UX reales; desplegar por cohortes con versión de contrato, no motores competidores.
- Migrar sesiones históricas por categorías y verificar originales; retirar adapters/gates obsoletos tras medir consumidores.
- Separar fixtures del motor retirado de la aceptación del runtime activo; actualizar arquitectura documentada cuando esté implementada.
- Aceptación: toda tarea aceptada tiene ejecución, espera explicada o resultado; evidencia incompleta tiene responsable y no mantiene al agente ejecutando. Ningún caso soportado necesita SQL particular para continuar.

## 13. Pruebas y criterios de aceptación

La matriz A01-A47, método, evidencias y métricas viven en el [anexo de validación](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_VALIDATION_2026-10-28.md). Es parte normativa de este plan, no una suite ya implementada.
Pruebas de infraestructura verifican invariantes; evaluaciones del agente verifican resultados sin exigir una secuencia de herramientas. PostgreSQL multi-conexión y staging aislado cubren límites de mocks. Incluir corrida >1 hora, procesos largos, cambios de worker, presupuesto y cierre Git sin retener el agente. No usar credenciales/datos reales en fixtures ni desactivar protecciones de cleanup.

## 14. Migración, despliegue y rollback

1. Inventariar versiones API/frontend/Workflow, contratos de herramientas, SQL aplicado y sesiones activas. La lectura del repo no acredita deploy.
2. Expandir esquema sin activar nueva semántica; desplegar lectores compatibles, inventariar/sanear datos y ensayar backfill acotado. No redefinir `null`, enums o vínculos por default implícito.
3. Cambiar escritores por contrato y cerrar las rutas antiguas incompatibles; runtime anterior termina/draina antes de transferir ownership. Aplicar nuevas restricciones sólo después de sanear conflictos y comprobar todos los escritores.
4. Migrar sesión por sesión con versión/CAS, conservando mensajes, archivos, contadores, presupuesto y operaciones. Unicidad sobre binding, no sobre filas de historial. No inferir efectos sólo de texto libre ni hacer backfill que publique datos históricos privados en Git.
5. Pausas históricas: automática para causas comprobablemente recuperables; pausa de usuario intacta; efecto incierto requiere prueba; estado inválido se conserva con diagnóstico.
6. Desplegar frontend compatible con la operación de control y eventos; eliminar updates directos sólo con backend operativo.
7. Canary aislado -> cohorte reducida -> expansión según A01-A47 del anexo y métricas. Nunca shadow execution con efectos sobre el mismo recurso.
8. Retirar legacy sólo después de comprobar consumidores y sesiones; conservar historial auditable y documentación de cambios.

Rollback: detener admisión al contrato nuevo, dejar concluir/drainar owners válidos, conservar formatos nuevos y volver sólo a una versión capaz de leerlos. Si no puede, pausar ese cohort y corregir; no iniciar motor viejo sobre snapshots incompatibles. Un rollback no revierte efectos externos ni renueva presupuestos.

## 15. Decisiones pendientes y validaciones comunicadas al usuario

Registro completo D1-D7/V1-V6 en el [anexo de validación](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/ASSISTANT_HARNESS_VALIDATION_2026-10-28.md), con fase afectada y propuesta, sin convertir pendientes locales en bloqueo de todo el plan.
Pendientes de producto: alcance de autorización externa; 70% por tarea o reserva global; transición de `null`; política económica de nuevas peticiones/revisiones/recurrencias; resolución de evidencia permanentemente pendiente. Margen de cierre/retención requieren propuesta técnica/costo. Destino Git, wakes, esquema, compatibilidad y permisos son validaciones de ingeniería, no preguntas sobre cada acción.
Las decisiones ya recibidas (núcleo, modalidades, único requerimiento, step amplio, planificación, información faltante, presupuesto y evidencia Git) se conservan. No interpretamos «lo demás bien» como aprobación de variantes económicas que aún no se habían definido.

## 16. Evidencia de verificación y definición de terminado

Durante el diagnóstico previo, con Node 22: `test:harness:agent` 48 suites/536 pruebas; `test:harness` 226 suites/3555 pruebas; cinco suites focalizadas de compatibilidad 142 pruebas. Estos resultados describen el baseline local; parte de la suite prueba fixtures retiradas y límites simulados. No son E2E de producción ni evidencia de que este plan ya funciona.
El recorrido E2E de robots del frontend examinado estaba bloqueado por falta de fixture aislada; resolverla sin quitar sus protecciones de cleanup.

Comandos existentes para futuras verificaciones, ejecutados desde la raíz absoluta de API:
```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
npm run test:harness:agent
npm run test:harness
npm run test:ai
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```
No asumir que esos testMatch incluyen todos los tests de workflow-robot. Inventariar suites CJS/ESM y añadir selección explícita compatible para run-plan, relaciones, result-gate, materialización, triggers, presupuesto y nuevos subflujos; verificar descubrimiento antes de reportar coverage. Ejecutar build/compilación Workflow en el ambiente autorizado cuando cambien wrappers; no cargar credenciales o disparar servicios remotos sólo para validar este Markdown.

Definición de terminado:
- [ ] Peticiones y steps amplios ejecutan mediante `instance/assistant`; no hay segundo agente canónico.
- [ ] Directo/harness comparten tools, contexto y presupuesto; cero/un requerimiento por instancia, sin selector nuevo, activación implícita ni pérdida de revisión de terminados.
- [ ] Workflows y sus consumidores conservan contratos y pasan pruebas conectadas/live aisladas.
- [ ] El agente puede planear, corregir y ejecutar subflujos sin cortes artificiales del step lógico.
- [ ] Steps/planes admiten ciclos de mejora por usuario o política del loop, preservan versiones válidas y no convierten falta de mejora en bloqueo ni repiten efectos externos.
- [ ] Presupuesto raíz, fallback y margen de entrega funcionan con concurrencia y costo real.
- [ ] Información faltante evidente se pregunta al inicio; dificultades posteriores se resuelven autónomamente cuando es posible.
- [ ] Entorno, procesos, memoria y archivos sobreviven a los fallos soportados con pérdidas explícitas.
- [ ] Entregables cloud funcionan sin sandbox y el asistente normal puede provisionar workspace mediante sus herramientas, sin requerimiento ni ciclo cron.
- [ ] Toda entrega íntegra positiva/negativa tiene evidencia Git confirmada; ejecución terminal libera recursos y publicación pendiente permanece visible sin repetir efectos ni fingir cumplimiento.
- [ ] Continuar no requiere scripts particulares; estados de UI reflejan hechos y no sólo updates.
- [ ] No duplicación de efectos, ampliación de permisos, exposición de secretos ni falso cumplimiento.
- [ ] Versiones/migración/rollback probados, límites publicados y documentación actualizada tras deploy.

Referencias internas: [arquitectura actual](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/REQUIREMENT_AGENT_HARNESS.md), [política de secretos](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/SECRET_SCANNING.md), [índice](/Users/prado/Desktop/Proyectos/Uncodie/Code/API/docs/README.md). Este plan guía la implementación futura; no sustituye la evidencia de estado actual.