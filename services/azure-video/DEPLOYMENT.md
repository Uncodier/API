# Deployment record — 2026-11-03

## Actual cloud state at handoff

- Subscription: `7410985e-126b-4f8b-94a5-670e792d65ec` (Startup Program).
- Resource group: `rg-makinari-video`, Central US.
- Initial ARM deployment: `video-foundation`, **Succeeded** at 23:23 UTC.
- `makinari-video-env`: **Succeeded**; gateway HTTP checks passed on the live host.
- Endpoint: `https://makinari-video.kindmoss-3ca2ca2e.centralus.azurecontainerapps.io`.
- Identity: `makinari-video-identity`, created; AcrPull granted on the existing ACR.
- Storage: `mkvideo6096e47b48`, created with shared-key/public-blob access disabled.
- Container `videos`, queue `video-jobs`, seven-day lifecycle policy: succeeded.
- Registry: existing `uncodietmpacr`, repository `makinari-video/foundation`.
  ACR builds succeeded (including the pinned-base build). No existing app changed.
- **No GPU, Azure ML compute, downloaded model weights, or inference execution.**
- **No OpenRouter registration or production API configuration changes.**

The gateway was redeployed with immutable image digest and credential/image-specific
revision suffix. Final ready revision: `makinari-video--r67d4158bf6df3e4b`.
Image digest: `sha256:50165da065b8d540bd809707e916552bbcfdc3814a0651991fe1d69bff1a363a`.
The successful apply is tracked in `/tmp/makinari-video-apply.log`; the earlier
validation attempt was transiently unsuccessful and was rerun successfully.
Do not register it as an available OpenRouter model: generation remains disabled.

## Check completion (read-only)

```sh
az deployment group show --resource-group rg-makinari-video --name video-foundation \
  --query '{state:properties.provisioningState,outputs:properties.outputs}' -o json
az deployment operation group list --resource-group rg-makinari-video --name video-foundation \
  --query '[].{name:properties.targetResource.resourceName,state:properties.provisioningState}' -o json
```

Once succeeded, get the endpoint from the deployment output; use the credential
file path printed by the deployment script. The bearer value is not stored in
Git. Run the read-only smoke checks described in README.md.

## Validation completed

- Node tests passed: authentication fail-closed, malformed credential
  redaction, HTTP behavior for both base-path aliases and disabled generation.
- One Python deployment-template test passed: no GPU resources, scale bounds,
  secure token parameter, private storage data, credential file permissions.
- Python syntax and file whitespace checks passed.
- ARM validation passed after correcting an unsupported log destination setting.
- Live HTTP checks passed: health200, readiness503, unauthenticated401,
  empty authenticated catalog200, missing job/content404.
- 79 Node tests passed after async engine/storage/dispatch/worker/pump integration;
  Python deployment-template/preflight suites also pass. All inference tests use
  controlled local mocks, not a real model.
- Actual GPU inference and observed GPU scale-down have not been tested.

## Why video cannot be enabled yet

MiniMax authorization has not been supplied. A100 dedicated Azure ML quota in
Central US is0. Request96, ID `60f3d12a-5c70-4dab-b17f-b7d16df4d987`, submitted
23:38 UTC, subsequently **Failed: QuotaNotAvailableForResource**. AML total dedicated
cores0/350 and clusters0/200 are independent of Compute VM quotas. The provider
Microsoft.MachineLearningServices and Microsoft.Quota are now registered.

Async job/storage/dispatch/worker code now exists and passes offline tests, but
the GPU resources/runtime are not deployed or validated. No weights downloaded.
Cost admission beyond one node/finite job runtime and production moderation are
still pending. See README.md; code completion is not proof of usable inference.

## Worker build and recovery pump

ACR GPU build `cjy` was cancelled after remaining Running for several minutes,
to avoid continued build spend with quota and license blocked. No successful
worker image digest is available. `Dockerfile.worker` pins the official SGLang
runtime and checks required executables; it must still be built and tested after
authorization. No model weights are embedded in the Dockerfile.

`queue-dispatch.mjs` is a finite CPU recovery pump (max10 messages,110s budget).
It dispatches deterministic AML IDs and acknowledges only confirmed accepted
jobs. Messages with >=10 deliveries are retained for operator intervention, not
silently deleted. It is NOT deployed as a scheduled/event job yet; the active
design uses inline dispatch with same-key client recovery until that is added.

The complete user requirement is **not fulfilled**: no working GPU inference,
real sample video, cost measurement, observed GPU shutdown, production moderation,
or OpenRouter upstream approval. Do not represent the deployed gateway as a live
video generator. Required external actions: Azure quota/support escalation for
the failed request and written MiniMax authorization for the intended use.

## Alternative-region quota checks — 2026-11-03

Read-only AML catalog checks confirmed NC96ads_A100_v4 in East US 2, West US 3,
Canada Central and Brazil South. Each had A100 dedicated quota0 and total
dedicated quota350. Catalog presence is not physical capacity or quota approval.

- Canada Central request96: `e298ff57-4942-4ce4-97f7-f64fb9b4b3a0`,
  **Failed / QuotaNotAvailableForResource**.
- Brazil South request96: `fb923860-92a2-4b33-80b4-a6e0e7cb938c`,
  **Failed / QuotaNotAvailableForResource** at final check.

These quota requests did not provision GPUs or relocate any existing resource.
Changing the hosting region alone does not remove MiniMax's restrictions on
the operator, end users or distribution of outputs.