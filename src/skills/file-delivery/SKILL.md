---
name: file-delivery
description: Saves and pushes private files to Git for any agent when delivering presentations, slides, decks, documents, reports, spreadsheets, sheets, CSV, HTML or Markdown. Use for guardar, subir, empujar archivos, presentaciones, documentos, hojas de calculo and tablas without a sandbox or app deployment.
types: ['develop', 'automation', 'content', 'design', 'task', 'integration', 'planning', 'research', 'marketing_campaign', 'optimization', 'strategy']
---

# Private file delivery

## Objective

Deliver a real downloadable, versioned document and its Git persistence receipt from any agent role, including workflow and workspace agents. This is document delivery, not application deployment.

## Instructions

1. Discover `deliver_file` through `tools` with `action="describe"` and `name="deliver_file"`. Loading this skill supplies the procedure; the tool remains on demand through the router. Do not claim file delivery is unavailable merely because its schema is not directly exposed.
2. Choose an honest supported format: a self-contained HTML presentation (`text/html`), Markdown document (`text/markdown`), HTML report (`text/html`), or spreadsheet data as CSV (`text/csv`). All content must be UTF-8, at most 262144 bytes. Native PPTX, DOCX, XLSX, PDF and other binary files are not supported here. Do not rename text to those extensions, encode binaries as text, or claim CSV is an Excel workbook. If a native format is required, disclose this limitation rather than silently substituting it.
3. Use `tools action="call" name="deliver_file"` with JSON-encoded `args`. To save, send `action="create"`, a basename in `name`, the matching `mime`, and the complete authored `content`. Do not use placeholder content. For example, the argument fields for an HTML deck are `action`, `name`, `mime`, `content`; the name must end in `.html` and the MIME must be `text/html`.
4. Do not request a repository, branch, sandbox, coding agent or new requirement simply to save a document. The host binds the current instance and requirement and uses the configured private non-deploy Git repository. Do not supply identity overrides or an unrelated `requirement_id`. A skill never grants access to another user's files.
5. To find existing documents, call `action="list"` with optional `query`, `offset` and `limit`. To inspect one, call `action="read"` with `file_id` and optional `version`; follow `next_offset` while pinning the returned version. Do not search workspace files for a private delivered document, or cloud documents for application source.
6. To edit, read first, then use `action="replace"` with `file_id`, `expected_version` and `content`, or `action="patch"` with `file_id`, `expected_version` and exact `changes` (`old_text`, `new_text`). A conflict requires rereading; never blindly overwrite another agent's revision. After an interrupted create, list/read to reconcile before creating another copy.
7. Report the actual receipt: `saved`, `file_id`, `version`, `download_url`, `archive_url`, `git_status`, and `git_commit_sha` when present. `saved=true` means the document is stored; only `git_status="committed"` confirms Git persistence. Pending/failed/conflict is not a successful push. Keep the saved download available and explain the Git blocker without repeatedly recreating the file.
8. Do not claim a public preview or application deployment. Download and ZIP URLs are authenticated. An HTML file is a downloadable presentation, not a hosted website. For changes to an application branch, use the existing requirement command path instead of this capability.

## Tools

| Tool | When to use |
| --- | --- |
| `skill_lookup` | Load `file-delivery` from any agent role. |
| `tools` | Describe and call the on-demand delivery tool. |
| `deliver_file` | Create, list, read, replace or patch a private document and obtain saved/Git receipts. |

## Artifacts

- **Produces**: versioned private HTML, Markdown, CSV or other supported UTF-8 documents; authenticated source and ZIP downloads; Git status and commit receipt.
- **Consumes**: user-requested content and exact prior file versions for edits. Does not consume or modify app repository files, deployment configuration or execution ownership.