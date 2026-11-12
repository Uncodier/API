# Customer OpenRouter media

Local engineering checkpoint: 2026-11-12. No paid generation or verification,
production build, deployment, or remote migration was executed.

## Two independent paths

Without selected customer routing, existing Azure image/speech/transcription and
platform OpenRouter video configuration, pricing and billing remain unchanged.
Customer execution uses the authorized pinned `ExecutionRoutingReference`; it
never substitutes a platform key when discovery, credentials, artifacts or
persistence fail. Resource/tool/channel charges are independent of inference.

Speech and transcription services accept optional host-only `executionRouting`.
Images carry it across internal HTTP using the signed routing helper; public
prompt workflows persist the reference as workflow input rather than relying on
process-local scope. Request JSON payer flags are not authority. Image and audio
HTTP routes authorize the site before resolving customer credentials. Customer
HTTP generation requires stable `Idempotency-Key` admission.

## Implemented protocols and acceptance

Official documentation fetched read-only during this implementation:

| Capability | Protocol | Acceptance |
| --- | --- | --- |
| Images | [POST /api/v1/images](https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md) | Complete bounded RGB/RGBA PNG; CRC, inflation, scanline/filter, dimensions and aspect ratio validation. URL-only/SVG/animation rejected. Strict asset persistence and receipt-event linkage before response. |
| Speech | [POST /api/v1/audio/speech](https://openrouter.ai/docs/guides/overview/multimodal/tts.md) | Fully consumed bounded stream, exact MP3/PCM MIME; whole MPEG layer III frame boundaries (not ID3-only sniffing), complete PCM samples. No Azure configuration lookup. |
| Transcription | [POST /api/v1/audio/transcriptions](https://openrouter.ai/docs/guides/overview/multimodal/stt.md) | Bounded audio input, documented JSON base64 protocol, nonempty bounded text and usage evidence. |
| Embeddings | POST /api/v1/embeddings | Exact existing model/space and configured dimensions; finite ordered vectors, count/context limits. No silent index migration. |
| Video | [POST /api/v1/videos](https://openrouter.ai/docs/guides/overview/multimodal/video-generation.md) | Durable payer-pinned asynchronous submission/status/content lifecycle; see video implementation tests. |

### Video lifecycle

The video HTTP route authenticates inference principals and site ownership. Customer
submission requires a stable `Idempotency-Key`; host service calls sign their routing
reference and use a durable operation context or explicit host-only `operationId`.
Public prompt workflows persist that reference and a deterministic operation ID.
No customer video balance check or platform deduction occurs.

Forward migration `20261112060000_openrouter_customer_video_jobs.sql` stores the
credential-free job pin, immutable request/event/operation identity, provider job ID
and completion artifacts through service-only RPCs. It must be deployed before
routing storage is enabled. Forward correction
`20261112072000_openrouter_customer_video_durability.sql` is also required: it adds
revision/CAS checks, monotonic checkpoints, and immutable settlement payloads.
Neither migration has been applied remotely. Redis expiry does not
lose accepted job ownership or permit another POST: status recovers from SQL and
the separate durable dispatch ledger remains the single-use admission authority.
An accepted response lost before provider ID persistence remains uncertain and
requires reconciliation; no automatic paid resubmission is permitted.

Polling authorizes the local job independently of today's selected policy and
revalidates the original credential pin before provider I/O. It never follows
`polling_url`, signed/unsigned output URLs, or arbitrary provider fetch targets.
Only fixed-origin status/content endpoints are used, with redirects rejected.
Artifacts require bounded MP4 MIME and nested ISO-BMFF container/video-track/sample
description validation, AVC parameter sets, nonempty timing/size/chunk tables and
sample ranges inside `mdat`. Other codecs and fragmented movies currently fail
closed. Validation requires strict storage/asset acknowledgment and receipt linkage
before output release. This is structural validation, not codec decoding or a
visual quality assessment. Missing cost remains uncertain evidence, not zero.

Before receipt delivery, the exact receipt JSON and provider terminal outcome are
checkpointed. Lost ACKs retry that same JSON without repolling changing cost or
generation evidence. Differing later evidence belongs in the existing authorized
dispatch reconciliation workflow, never an overwrite or a new generation.
Completed/failed reads and receipt-only recovery require site authorization, not
an active provider credential. Artifact recovery uses the event UUID as asset
primary key and deterministic storage path; uploads never overwrite, and duplicate
objects must match bytes before insertion recovery. Concurrent asset inserts read
back the first durable asset rather than creating a second record.

This adapter supports text-to-video with catalog-validated duration, aspect ratio
and resolution. Frame/reference images, legacy quality and provider passthrough
options fail closed. The dedicated video protocol does not document enforcement
of chat-style `allow_fallbacks`; the adapter does not invent that field or claim
strict upstream BYOK-only provider selection. It never falls back to platform
credentials. Existing global video configuration, provider and billing are unchanged.

The speech API documents only `mp3` and `pcm`; customer requests for Azure-only
formats fail before dispatch. Provider voices and speed remain model-dependent:
invalid upstream options fail without global fallback. PCM has no container or
codec checksum; even sample length proves sample framing, not audible quality.
MPEG frame validation is structural, not a subjective listening test.

TTS/STT documentation explicitly says provider `only/order/ignore` options are
not applied. Customer-funded requests do **not** claim strict upstream provider
BYOK enforcement. Video is not eligible for ZDR upstream.

## Durable attribution and uncertainty

Every ordinary customer inference POST claims `openrouter_customer_dispatch`
before network I/O. Stable operation keys deduplicate retries; unknown acceptance
never authorizes another paid POST. The same event ID connects receipts and image
asset metadata. Receipt failures withhold output and require reconciliation.
Missing speech cost remains unknown, not zero. Requested model is not invented
actual-serving-model evidence. Customer generation never calls image credit
reservation/settlement; global Azure behavior retains those exact calls.

Image persistence is deliberately stricter than the legacy global best-effort
asset record: upload acknowledgment and asset insert are required. Failed asset
or receipt writes may leave an orphan uploaded artifact, but cannot release a
false success or trigger another paid generation.

## Explicit paid verification runner

`ai/customer-verification.ts::verifyCustomerImage` is host-only and does nothing
on import. The manager-authorized integration setup controller owns revision/CAS,
credential resolution, the durable single-use setup claim and final publication.
The runner requires explicit `consent: true`, a positive budget at most USD 1,
a server-derived bounded full-image quote within that budget, and exact provider
endpoint pin. It submits one fixed synthetic prompt, requests one PNG and disables
provider fallback. It validates actual serving model, generation ID, cost and
complete image, then persists the artifact linked to the setup operation.

Setup runs (including unselected connections) use their own durable customer-payer
receipt, not the selected-execution receipt RPC. A failed or ambiguous probe stays
uncertain; callers must not resubmit the operation. Publication includes model,
credential version, provider tag, adapter version `openrouter-images-png-v1`,
artifact/operation evidence and expiry. Ordinary image dispatch still requires
this live evidence; offline tests or catalog visibility cannot enable images.

Fixed endpoint catalog prices are quotes, not an immutable upstream hard spend
cap. Unknown/token/megapixel/variant-based pricing cannot provide the runner's
required total quote and fails closed. Price drift cannot be prevented by the
currently documented image protocol; no hard-cap guarantee is claimed.

## Local validation and remaining external gates

Offline tests cover real customer transports, whole artifact parsing, durable
claim rejection, no replay/fallback, missing cost, receipt/storage failures,
authorized image route admission, explicit verification consent/budget and global
Azure regression. They do not establish real provider readiness.

Actual connection-specific image verification remains unperformed by explicit
instruction. Video CAS, overlapping writes/inserts and exact receipt retries were
tested in a disposable socket-only PostgreSQL 17 cluster via market-fit's
`__tests__/integrations/customer-video-durability-sql.test.ts`. Offline recovery
tests exercise the real lifecycle/store/artifact/receipt modules with provider and
database/storage transports mocked. No live storage or provider success is implied.
Forward migrations have not been applied remotely. Unsupported
provider parameters and inability to prove a strict upstream price cap are
reported blockers, never reasons to use platform credentials.
