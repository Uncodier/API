---
name: makinari-obj-tarea
description: Objective skill for one-off tasks. Write a script, execute it, format results as Markdown, and deliver through the Markdown/Text Vitrina so the client can open a preview URL.
types: ['task', 'research']
---

# SKILL: makinari-obj-tarea

## Objective

Execute a one-off task (data extraction, research, API scrape, report generation) and deliver the result as a well-structured Markdown document injected into the Markdown/Text Vitrina. The client gets a shareable preview URL, not a raw file attachment.

## Execution Rules

### 1. Develop and execute the script
- Write the script under `/vercel/sandbox` using `sandbox_write_file` (Node.js or Python; pick whichever matches the task's dependencies).
- Run it with `sandbox_run_command` and capture both stdout and stderr.
- If the script fails, fix it before continuing — do NOT fabricate outputs.

### 2. Format the output as Markdown
The Markdown report is the deliverable. Use this template:

```markdown
# <Task title>

**Ejecutado:** YYYY-MM-DD HH:mm
**Fuente:** <API / dataset / URL scraped>

## Resumen
- <1-3 bullets with the headline findings>

## Métricas
| Métrica | Valor |
| --- | --- |
| Items procesados | <n> |
| Éxitos | <n> |
| Errores | <n> |
| Duración | <hh:mm:ss> |

## Detalle
<main body — tables, lists, snippets. Keep sections short. Cite sources inline.>

## Anexos
- <link to raw data / CSV / JSON exports if hosted>
- <any caveats the client must know>
```

**Rules**
- Language: match the client's language (Spanish by default for Uncodie clients).
- No raw console dumps. Clean up output into tables or bullet lists.
- Cite sources (URLs, file names, API endpoints) so the client can audit.
- If a section has no content for this run, remove it — do not leave `(none)`.

### 3. Deliver via the Markdown/Text Vitrina
- The base branch should already be selected by `makinari-obj-template-selection` (text/Markdown Vitrina).
- Read the current `src/app/data.json` with `sandbox_read_file`.
- Inject the Markdown report. Typical shape:
  ```json
  {
    "title": "<Task title>",
    "updatedAt": "YYYY-MM-DDTHH:mm:ssZ",
    "markdown": "<full markdown body>"
  }
  ```
- Persist with `sandbox_write_file`.
- Remove every demo / placeholder entry the Vitrina ships with.

### 4. Execution metrics
Record counts (items processed, successes, failures, duration) both in the Markdown "Métricas" table AND in the `step_output` you report back via `instance_plan`. This gives the client visible metrics and gives the orchestrator machine-readable ones.

### 5. Reporting
- Use `requirement_status action="create"` with:
  - `preview_url`: the permanent Vercel deployment URL (extracted by the system after push).
  - `message`: client-facing summary following the template in `makinari-fase-reporteado`.
- The workspace archive is uploaded on each `sandbox_push_checkpoint`.

## Tools

| Tool | When to use |
| --- | --- |
| `sandbox_write_file` | Create the script, the report, and update `src/app/data.json`. |
| `sandbox_run_command` | Execute the script, install any ad-hoc deps (`npm install`, `pip install`), read-only git. |
| `sandbox_read_file` | Read the Vitrina `data.json` before replacing demo content. |
| `sandbox_list_files` | Find the right data file if the Vitrina structure varies. |
| `requirements` | Read the task scope (section 3 Goals, section 4 Non-Goals). |
| `requirement_status` | Deliver the preview URL + message. |
| `instance_plan` | Report step status with execution metrics. |

## Artifacts

- **Produces**: the executed script (committed under `/vercel/sandbox`), the Markdown report (injected into `src/app/data.json`), execution metrics in `step_output`.
- **Consumes**: `requirement.instructions` sections 3 (Goals), 4 (Non-Goals), any source data declared in section 2 (Baseline).

## Anti-patterns

- Delivering raw console output as "the report". Always structure it.
- Leaving the Vitrina's demo content alongside the real report.
- Running the script once, seeing partial success, and shipping incomplete data. Re-run until the metrics are complete, or declare the gap explicitly in the report.
