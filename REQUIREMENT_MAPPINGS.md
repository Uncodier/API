# Mapeo de Requerimientos a Repositorios y Ramas Base (Vitrinas)

Este documento describe cómo el sistema de Makinari enruta cada tipo de requerimiento (`requirement.type`) hacia un repositorio específico y una rama base (Vitrina o Aplicación Genérica) cuando no se ha especificado un repositorio de forma explícita en la base de datos (`metadata.git`).

## 1. Mapeo de Repositorios por Defecto

Si un requerimiento no especifica un repositorio en su metadata, el sistema hace un "fallback" basado en la categoría (kind) del requerimiento:

| Categoría (`kind`) | Repositorio por Defecto (Env Var) | Valor Actual (`.env.local`) |
|--------------------|-----------------------------------|-----------------------------|
| `automation`       | `GIT_AUTOMATIONS_REPO`            | `automations`               |
| *Cualquier otro*   | `GIT_APPLICATIONS_REPO`           | `apps`                      |

## 2. Clasificación de Tipos de Requerimientos (`RequirementKind`)

El campo libre de texto `type` (o la intención detectada del requerimiento) se clasifica en categorías internas. Según esta categoría, se define el flujo de ejecución, el repositorio destino y las herramientas disponibles.

| Tipo Ingresado (Ejemplos de texto o tags) | Categoría (`kind`) | Repositorio Destino |
|-------------------------------------------|--------------------|---------------------|
| `integration`, `*automat*`, `automation`  | `automation`       | `automations`       |
| `app`, `develop`, `design`, `*app*`       | `app`              | `apps`              |
| `site`, `landing`, `website`, `*site*`    | `site`             | `apps`              |
| `doc`, `content`, `*blog*`, `*doc*`       | `doc`              | `apps`              |
| `presentation`, `*deck*`, `*slide*`       | `presentation`     | `apps`              |
| `contract`, `*contract*`, `*legal*`       | `contract`         | `apps`              |
| `task`, `planning`, `research`, `investigate` | `task` / `makinari` | `apps`          |

> **Nota:** Investigaciones (`research`), tareas genéricas y requerimientos de desarrollo siempre caen por defecto en el repositorio de **aplicaciones (`apps`)**, a menos que se fuerce la propiedad de `metadata.git` en la BD al momento de crearlo.

## 3. Mapeo de Ramas Base y Vitrinas

Una vez en el repositorio correcto (usualmente `apps`), la skill `makinari-obj-template-selection` decide qué rama usar como base dependiendo del "estilo del entregable". 

### A. Vitrinas (Formatos Fijos empaquetados)

Si el sistema detecta que se quiere un entregable de formato fijo (texto, presentación, tabla, etc.), clona una de estas vitrinas:

| Estilo de Entregable | Rama Base (Branch en GitHub) |
|----------------------|------------------------------|
| Text / strategy / long-form (Markdown) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/424cc56d-510e-4bbf-a4e1-aa2e30700325` |
| Media / design (galleries, icons, video) | `feature/9be0a6a2-5567-41bf-ad06-cb4014f0faf2/512ceb6a-f133-4716-9a10-0d2a008c10ed` |
| Commercial decks / pitch / slides | `feature/ce1b2fec-3455-49a1-a35d-54671c00d00d` |
| PDF documents (interactive viewer) | `feature/16ccdd2c-6636-4b38-a4fc-89ea2c9fe0cc` |
| Data / analytics (heavy tables, CSV/JSON)| `feature/6e819746-5da2-4e3a-8192-0a592dff99cc` |
| Automation runner / webhook tester UI | `feature/c3dcbbab-585a-46e9-b320-19b149a24aa0` |

### B — Aplicaciones Genéricas (Custom SaaS, Dashboards)

Si el requerimiento es un desarrollo de producto complejo o la instrucción no especifica una Vitrina:

| Escenario | Rama Base |
|-----------|-----------|
| Aplicación genérica, landing, plataforma o cualquier otro requerimiento de desarrollo ("Generic application") | `main` |

> **Nota:** La rama `main` en el repositorio de aplicaciones actúa como la base principal ("repository intelligence base" con el home personalizado). Para cualquier requerimiento genérico, se debe utilizar `main` como punto de partida.
