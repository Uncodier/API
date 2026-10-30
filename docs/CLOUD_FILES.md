# Cloud deliverables and requirement execution environments

## Implementation

Requirements have an explicit `execution_environment`: `cloud` or `workspace`,
persisted in `metadata.execution_environment` and immutable after creation.
Missing values on legacy records retain workspace semantics. Titles, types, file
extensions and model prose never switch a running owner silently. The assistant
must choose explicitly when creating a requirement:

- **cloud**: documents, reports, Markdown, CSV, JSON and bounded text deliverables
  with private Git evidence; no application or sandbox.
- **workspace**: repository changes, commands, browser work or executable code.

Cloud creation rejects app Git bindings and skips apps repository resolution.
Cloud cron branches before profile/checkout/workspace setup, using the same
canonical assistant turn and durable execution boundary with no repository or
workspace. Billing and ownership checks remain. The catalog is filtered before
router construction: cloud requirements cannot call sandbox/workspace/deployment
tools; workspace requirements do not search cloud files. Unbound conversations
expose both distinctly named families without allocating either at construction.
File-family selection checks both runner metadata and all scoped plan associations.
An explicit contextual requirement ID must match that binding, not override it.
Plans are paginated and deduplicated before selecting a requirement; conflicting
bindings or an exhausted lookup bound fail closed rather than choosing arbitrarily.

## Tools and persistence

| Tool | Contract |
| --- | --- |
| `list_cloud_files` | Optional `requirement_id`, `query`, `offset`, `limit`. Query searches authorized names/content. Bound requirements default to their own ID and cannot override it. Metadata-only results and pagination. |
| `read_cloud_file` | `file_id`, optional immutable `version`, `offset`, `max_chars`. Bounded content pages plus exact full-file hash/bytes and cursor. |
| `write_cloud_file` | `action=create/replace/patch`. Create uses name/content/MIME. Edits require ID and `expected_version`; patch uses exact bounded `old_text`/`new_text` changes. |

Site, actor, instance and requirement scope come from the authenticated host.
Requirement-bound interactive chats read documents but submit changes through the
existing requirement command path; only its durable owner writes. A requirement
filter never authorizes browsing another instance. No search-both fallback exists.

Private text content, SHA-256, UTF-8 byte length and version metadata commit in one
Postgres transaction, with a **256 KiB document limit**. This uses database text
rather than mutable storage blobs, avoiding content/metadata split-brain.
Revisions are immutable; stale edits return conflict without overwrite. Host
operation UUIDs support exact replay and reject reuse with different input.
The operation journal stores a canonical argument SHA-256 and the immutable
revision/state reference, not duplicated document bodies. Replay returns the same
document revision and operation outcome with current Git evidence metadata.
Supplied names, MIME, content and aggregate patch size are checked before recording
even a stale-version conflict.
RPCs enforce current actor access and tenant/instance/requirement linkage, with
RLS and no direct public table access.

Aggregate logical quotas include historical content and fixed metadata overhead,
files and operation receipts. Writes serialize quota admission per site and roll
back atomically on `quota_exceeded`; replay of an existing operation still works.

| Scope | Logical bytes | Files | Operation receipts |
| --- | --- | --- | --- |
| Instance | 32 MiB | 1,000 | 10,000 |
| Site | 256 MiB | 10,000 | 100,000 |

These are application storage budgets, not measurements of PostgreSQL physical
pages/WAL. Deletes release the logical quota through the existing cascades.
Interrupted writes reconcile by reading the authorized atomic operation journal;
missing receipts remain unknown, never assumed safe to replay. Cloud sessions pin
their originating instance. Replacing/archiving that runner requires explicit
reconciliation rather than silently moving documents or returning an empty listing.
Deleting an instance/requirement cascades its database documents, revisions and
operation receipts. Git history is a separate retained copy: repository retention
and erasure must be managed by the platform operator, not assumed from DB deletion.

## Private Git evidence

Required server-only configuration:

```text
CLOUD_FILES_GITHUB_REPOSITORY=owner/private-document-repository
CLOUD_FILES_GITHUB_TOKEN=<dedicated secret supplied outside source control>
CLOUD_FILES_GITHUB_NO_DEPLOY=true
```

`NO_DEPLOY` is an operator acknowledgement: disable all deployment integrations,
Actions/workflows and external hooks for this destination before enabling it.
The code checks repository privacy, but privacy cannot prove absence of external
deployment hooks. No fallback to apps repos, `GITHUB_TOKEN` or public storage is
allowed. Do not give tenants direct access to a shared multi-tenant repository.
The repository must already contain an initial commit. Empty repositories return
`repository_uninitialized` before any content upload or immutable target binding;
initialize the dedicated destination explicitly, then the pending revision can
retry. The publisher never bootstraps a default branch implicitly.

Each revision publishes a one-document tree to a hashed tenant/instance/file/version
ref through Git Data APIs, without shell or clone. A verified previous commit is
used as parent when available. Exact remote bytes, Git blob hash and SHA-256 must
match before `committed`. Refs are never force-updated. The same immutable content
feeds ZIP and Git, not a later mutable version.
The destination repository/ref/path is bound durably before publication. Changing
environment configuration cannot repoint an existing revision to a different repo.
Enterprise-internal and public repositories are rejected, not treated as private.

Git outage leaves the document saved with pending evidence, not a running agent.
Durable publication intents retry with bounded backoff in the existing requirement
cron, including after task completion, without model replay. Receipts distinguish
`saved`, `git_status` and verified commit SHA. Never interpret saved as fully
delivered/versioned. Existing uncertain-operation fences remain unchanged.

## Download and UI

Version-pinned relative URLs use:

```text
/api/robots/instance/{instanceId}/cloud-files/{fileId}?version=N&format=zip
```

The API verifies bearer identity and current permissions, serving exact stored
revisions with no-store, attachment and nosniff headers. Text is served as plain
text. The frontend uses a same-origin authenticated proxy and the existing
ZipViewer; these private URLs never go through the public URL proxy.
Archive trees use prototype-free dictionaries, including for names such as
`__proto__` and `constructor`. Changing a revision invalidates outstanding loads
and resets selected files and unsent edits; same-revision rerenders preserve them.

## Rollout and verification

Database rollout confirmed on 2026-10-30 for project `rnjgeloamtszdjplmqxy`:
both migrations below were applied together in one PostgreSQL transaction and
recorded in `supabase_migrations.schema_migrations`. Exact copies are retained in
the sibling `makinari-db-scheme/supabase/migrations` source-of-truth directory.
These migrations are now applied: future schema fixes require new migrations.
Verification confirmed four empty private tables with RLS, service-only RPCs,
enabled triggers and zero incompatible existing harness snapshots. This does not
assert API/frontend deployment, Git configuration or production E2E completion.

Apply forward migrations before enabling cloud requirements:

1. `20261030010000_cloud_document_persistence.sql`
2. `20261030020000_cloud_requirement_sessions.sql`

Deploy the API and companion frontend proxy/viewer change. Configure and review
the dedicated private Git target first; do not silently substitute a user repo.
No remote migration or production E2E is implied by local tests. Old readers require
a repository: drain cloud admission and preserve the new reader before rollback,
never rewrite cloud sessions as workspace runs.

```sh
npm run test:harness:cloud
npm run test:assistant-runtime
npm run test:harness
npm run test:harness:cloud:unit
npm run test:harness:cloud:contracts
```

The cloud suite executes actual tools/store/SQL and provider-boundary tests offline.
PGlite tests do not prove multi-connection production load. The contracts command
still exits 2 for **live verification required**, not missing implementation; it
does not claim deployed storage/Git/UI/cost verification.