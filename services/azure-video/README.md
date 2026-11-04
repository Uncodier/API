# Azure video service — production activation blocked

## Implementation update

The repository now includes the real async orchestration code, not just the initial
admission stub: `jobs.mjs` (CAS/idempotency/leases), `azure-store.mjs` (managed
identity Blob/Queue REST), `dispatcher.mjs` (deterministic Azure ML command jobs),
`worker.mjs` (one local SGLang inference), `start-worker.sh` (bounded runtime
startup/shutdown), and `gpu-deploy.py` (quota-gated AML infrastructure plan).
The deployed gateway remains disabled. No model has been downloaded or video
generated. The following original foundation details describe that disabled state.

This isolated service does **not** generate videos yet. It never downloads model
weights, launches GPU compute, enqueues requests, or returns simulated successes.
Existing Makinari tools, API routes, and OpenRouter configuration are unchanged.

## Verified deployment constraints (2026-11-03)

- Subscription: Azure subscription (Startup Program), sponsorship offer;
  spending limit is off. Remaining credit balance has not been verified.
- East US A100/H100 family quotas: zero. Regional vCPU limit: 65; the proposed
  four-A100 NC96ads_A100_v4 requires 96. Other regions have not been checked.
- Microsoft.MachineLearningServices was not registered at inspection time.
- MiniMax H3 commercial/territorial authorization has not been confirmed.
- H3's documented example uses four GPUs. Container Apps Consumption does not
  support multi-GPU replicas, so the proposed future worker belongs on an Azure
  ML compute cluster with min nodes 0, max nodes 1 (or another validated job platform).

## Foundation resources

`deploy-foundation.py` creates a separate resource group, user-assigned identity,
a Consumption workload profile (no dedicated profiles) in a new Container Apps environment, and
a CPU gateway with min replicas 0 / max replicas 1 (0.25 CPU, 0.5 GiB).
It does not create dedicated workload profiles, GPU nodes, or a Log Analytics workspace.
The existing ACR is reused for an isolated `makinari-video/foundation` image and
an AcrPull role grant; other services and images are not changed.

A Standard LRS storage account has shared-key access and public blob access
disabled, a private `videos` container, a `video-jobs` queue, and a seven-day
video deletion policy. Its network endpoint is public; **data is not anonymous**.
No storage data role is assigned yet because this gateway does not consume storage.

CPU can scale to zero; storage, ACR builds, networking, and auxiliary services
can still have charges. Scale-to-zero is not a guarantee of a zero Azure bill.
The configured replica limit bounds concurrency, not cumulative monthly spend.

## Current HTTP contract

The base paths `/v1` and `/api/v1` are aliases. Except `/healthz`, every route
requires `Authorization: Bearer` with the locally provisioned credential.
Only its SHA-256 digest is stored in the app's Azure secret configuration.

| Route | Current behavior |
| --- | --- |
| `GET /healthz` | 200, process liveness only |
| `GET /readyz` | 503, explicit deployment blockers |
| `GET /v1/models` | 200, empty list |
| `GET /v1/videos/models` | 200, empty list |
| `POST /v1/videos` | 503 `generation_not_enabled`; no job or charge |
| `GET /v1/videos/{id}` | 404; no jobs exist |
| `GET /v1/videos/{id}/content` | 404; no content exists |

This is not a complete OpenAI video implementation and is not certified as an
OpenRouter upstream. OpenAI and OpenRouter have different video request contracts;
the active implementation must normalize multipart vs JSON, `seconds` vs
`duration`, sizes vs aspect ratios, references, and status names explicitly.
Do not register it as an available MiniMax model while the catalog is empty.

## Deploy and test

Requirements: authenticated Azure CLI with permissions to create resources and
role assignments, Python 3.9+, Node 22.12+ for tests. No local Docker required;
ACR builds the minimal Node container from a pinned base digest and deployment
uses the resulting image digest. ACR must use legacy registry permissions and
permit ARM authentication for managed-identity pulls. No new application package dependency.

From this directory, pass the intended subscription and existing registry:

```sh
python3 deploy-foundation.py --subscription "$AZURE_SUBSCRIPTION_ID" --registry "$AZURE_CONTAINER_REGISTRY"
node --test server.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 deploy_test.py
python3 smoke.py --endpoint "$VIDEO_ENDPOINT" --token-file "$VIDEO_TOKEN_FILE"
```

Credentials are generated outside Git under
`~/.config/makinari/rg-makinari-video-video-token` with mode 0600. Never paste
the credential into logs, tickets, commands, or documentation. Keep it private;
use a secrets manager before enabling third-party integrations. Rerunning the
deployment preserves this credential. Rotating requires replacing it securely
and redeploying the digest, then updating authorized callers. The revision suffix
depends on the image and credential digest so rotation creates a new revision.

The ARM template is generated in a private temporary directory and validated
before deployment. The deployment uses incremental mode; it does not delete
resources not declared in the template.

## Remaining implementation before accepting jobs

1. Obtain H3 authorization covering the legal entity, hosting region, users, and
   distribution of outputs; archive the approval outside this public codebase.
2. Confirm credit eligibility/balance, select region, secure GPU and regional
   vCPU quota, register Azure ML, and verify actual GPU capacity.
3. Pin and audit the H3 runtime/dependencies. Build a separate worker image;
   store authorized weights privately. Benchmark cold and warm 768p inference.
4. Implement durable tenant-scoped job state, idempotency, queue delivery leases,
   worker ownership, finite retries/dead letters, cancellation, output retention,
   moderation, authenticated content download, and cost admission limits.
5. Bind one execution to a capped GPU job timeout; scale worker to zero after
   queue drain. Reconcile crashes without blindly repeating paid inference.
6. Implement and test the complete asynchronous video contract and references
   validation (including SSRF protections). Do not proxy arbitrary supplied URLs
   or forward credentials to generated URLs.
7. Measure total cost per usable video minute; do not use hypothetical timings
   as a customer price guarantee. Resolve how compute costs map to API usage.
8. Obtain OpenRouter Enterprise private-provider/video approval and upstream
   protocol requirements, validate catalog equivalence, polling/content/usage,
   and configure fail-closed routing without public-provider fallback.

Activation requires all three explicit gates `VIDEO_GENERATION_ENABLED=true`,
`H3_LICENSE_APPROVED=true`, `H3_WORKER_READY=true` plus valid storage and AML
configuration. Do not set these merely to make readiness green. They are operator
attestations, not automated verification of licensing, capacity or quality.

## Implemented asynchronous contract (when authorized and provisioned)

`POST /v1/videos` accepts JSON with `prompt`, `model: h3-base`, `seconds` (or
`duration`/`duration_seconds`), `aspect_ratio` (16:9,9:16,1:1), `resolution:768p`,
and optional uint32 `seed` (default0). An `Idempotency-Key` header is mandatory.
Repeated identical submissions return the same durable ID; a different payload
using that key returns409. Unknown fields and image/audio references are rejected,
not silently ignored. Multipart OpenAI upload compatibility is not implemented.
Status responses use OpenRouter-style pending/in_progress/completed/failed and
OpenAI-style `id`, `object`, `seconds` fields. This is an intentional subset,
not certification of either upstream protocol.

One shared service credential defines one security principal. This endpoint is
for trusted Makinari/OpenRouter callers, not public end-user credentials. Tenant
authorization must remain enforced in the calling system or be extended before
direct multi-tenant exposure. At most two HTTP handlers are admitted concurrently.

Jobs persist in private Blob storage using ETags. A queue outbox is published and
the gateway dispatches the same deterministic AML job ID. A client must retry an
ambiguous submission with the SAME key. Worker CAS permits only one inference
attempt. An expired in-progress lease fails as ambiguous, never re-runs GPU work.
Queued jobs expire after one hour on subsequent access. This is not a periodic
reconciliation process. See queue-dispatch files if present for the optional queue
recovery pump; it is not deployed/activated by the foundation deployment.

AML is capped to one node (0 minimum), 120s idle scale-down and 30-minute command
job timeout. The worker calls only loopback SGLang, polls with a finite deadline,
rejects remote download redirects, uploads <=100MiB MP4, and marks success only
after persistence. MP4 signature validation is not a full playback/audio-quality
validation. Startup and subprocess cleanup must be verified on real GPU hardware.
Weights currently download per worker startup (no warm shared model cache is
configured). The bounded download can fail on slow cold starts; do not claim a
latency SLA or benchmark cost from this implementation.

## Remaining production gates (not solved by passing unit tests)

- Quota request `60f3d12a-5c70-4dab-b17f-b7d16df4d987` for 96 AML A100 cores in
  Central US was rejected with `QuotaNotAvailableForResource`. Family remains0.
  AML total cores350 already suffices; Compute VM total65 is a different quota.
- Obtain MiniMax approval for Makinari and hosting/users/outputs territory.
- GPU image and runtime validation; AML linked-resource RBAC validation; actual
  generated audio/video playback; observed GPU scale-down and cost benchmark.
- Prompt/output moderation, enforceable end-user terms, reporting/abuse handling,
  cumulative spending/backlog limits, and cost accounting are still required.
- OpenRouter private-provider video onboarding and model equivalence approval.

GPU plan script never submits inference. It requires an immutable worker image,
reviewed license document identifier, explicit resource IDs and passing AML quotas:

```sh
python3 gpu-deploy.py --subscription "$AZURE_SUBSCRIPTION_ID" \
  --group "$VIDEO_RESOURCE_GROUP" --location centralus --workspace video-ml \
  --compute video-gpu --sku Standard_NC96ads_A100_v4 \
  --storage-id "$VIDEO_STORAGE_RESOURCE_ID" --registry-id "$VIDEO_ACR_RESOURCE_ID" \
  --dispatcher-principal-id "$VIDEO_GATEWAY_PRINCIPAL_ID" \
  --image "$VIDEO_WORKER_IMAGE" --license-proof-ref "$H3_LICENSE_PROOF_REF"
```

Only after resolving those blockers should an operator use `--apply`. No fake
license-proof reference should be supplied to bypass the gate.

## Cleanup

Review and delete only the dedicated `rg-makinari-video` resource group when no
longer needed. The AcrPull assignment on the shared registry and the isolated
`makinari-video/foundation` image must be reviewed/removed separately. Do not
delete the shared ACR or `rg-temporal-prod`. Remove the local credential securely
when retiring the service.