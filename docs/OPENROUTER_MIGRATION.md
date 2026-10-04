# OpenRouter migration

## Runtime direction

OpenRouter handles text, agents, embeddings, speech, transcription and video,
without Portkey in between. **Image generation is the explicit exception: Azure
direct**, using the existing server credentials. The existing OpenAI SDK is reused
for compatible OpenRouter endpoints; video uses its dedicated API. Gateway,
model vendor and Azure deployment names are distinct.

| Capability | Default / required selection |
| --- | --- |
| Chat and agent tools | `OPENROUTER_CHAT_MODEL`, default `openai/gpt-6.1-sol` |
| Embeddings | `openai/text-embedding-3-small`, 1536 dimensions by default |
| Image generation | Azure direct: `AZURE_OPENAI_IMAGE_DEPLOYMENT`, default `gpt-image-2.5-sunburst` |
| Video generation | Explicit `OPENROUTER_VIDEO_MODEL` required |
| Text to speech | `OPENROUTER_TTS_MODEL`, default `microsoft/mai-voice-2.1` |
| Speech voice | `OPENROUTER_TTS_VOICE`, default `es-MX-Valeria:MAI-Voice-2.1` |
| Transcription | Explicit `OPENROUTER_TRANSCRIPTION_MODEL` |

Historical OpenRouter image check on 2026-10-03: one `POST /images` for Sunburst, 1024x1024,
low quality, pinned to Azure, returned HTTP 404 in 588 ms. OpenRouter explicitly
reported that only `openai` serves the selected model and `provider.only=["azure"]`
excludes it. No image was generated and no alternate provider was attempted.
That OpenRouter Azure route was blocked; this was not a credit-balance error.

Image routing now calls Azure directly, with no OpenRouter dependency, retries or
alternate-provider fallback. Read-only Azure catalog and deployment-list queries
returned HTTP 200 on 2026-10-03 and confirmed the existing
`gpt-image-2.5-sunburst` deployment. This is **not** a completed generation test.
No image inference or paid smoke test was run for the direct-Azure change.

`provider` is omitted or `azure`; old `provider: 'openrouter'` image requests are
rejected. `model`, when supplied, must be an Azure deployment name, not
`openai/...`. The default endpoint is `/openai/v1/images/generations?api-version=preview`.
Reference URLs are validated and downloaded without credentials (up to four PNG/JPEG
images, 20 MiB each), then uploaded through multipart `images/edits` with `image[]`.
Generated PNGs still use the existing storage/assets and site credit logic.

Aspect ratios map to explicit Azure pixel sizes. Custom sizes must use multiples
of 16, 655,360–8,294,400 total pixels, edges at most 3,840 and ratios at most 3:1.
Conflicting size/ratio inputs fail instead of discarding one. Legacy 256/512 square
requests to the public cached endpoint generate at 1024 square. Explicit deployment
overrides must support the chosen parameters; Azure validates their actual model
capabilities because deployment aliases cannot reliably identify a model. Quality aliases `standard`/`hd`
map to `medium`/`high`; Sunburst supports `auto`, `low`, `medium`, `high`, `xhigh`, `max`.

Public catalog inspection found `openai/sora-2-pro`, not the selected Sora 2 base,
and did not find `tts-hd`/`tts-1-hd`. TTS now uses MAI-Voice-2.1 through OpenRouter,
with a catalog-verified Spanish voice; speech remains on OpenRouter.
The code must not silently replace the video
model with Pro or assume Azure deployment names are OpenRouter model IDs.
Catalog presence is not an inference test or a guarantee of account eligibility.

Embeddings keep the existing model and dimensions. Changing the model for stored
vectors requires re-embedding the corpus, even if dimensions match. Do not use a
different embedding model as an automatic fallback.

## Deployment configuration

1. Set `OPENROUTER_API_KEY` in the server secret store. Never use `NEXT_PUBLIC_*`
   for credentials. No production secrets are included in this repository.
2. Remove stale `AI_PROVIDER` and `AI_MODEL` settings. The migrated
   agent executor deliberately ignores legacy provider/model environment defaults.
   Use `OPENROUTER_CHAT_MODEL` for chat and `AZURE_OPENAI_IMAGE_DEPLOYMENT` for
   images. Existing persisted model choices remain
   explicit choices; review them before rollout. Private Azure deployment aliases
   need mapping to real OpenRouter model IDs, not just a vendor prefix; the agent
   executor rejects explicit Azure endpoint/deployment configuration.
3. Optionally set `OPENROUTER_APP_URL` and `OPENROUTER_APP_NAME` for attribution.
4. Speech needs only the same `OPENROUTER_API_KEY`. Optional `OPENROUTER_TTS_MODEL`
   and `OPENROUTER_TTS_VOICE` override the defaults above. When changing the model,
   supply a voice supported by it; OpenAI voices such as `alloy` are not universal.
   Speech output is MP3 by default; PCM is also supported. Other containers are
   rejected rather than returning mislabeled bytes. No `AZURE_TTS_*` or speech
   provider selector is required. Old `AI_TTS_PROVIDER` and
   `AI_TRANSCRIPTION_PROVIDER` environment settings cannot redirect traffic.
5. Select video and transcription models explicitly after checking the current
   catalog and pricing. Until then these capabilities are intentionally not
   enabled. Existing voice-note ingestion needs a transcription model before rollout.
6. Configure the existing Upstash service for distributed media admission and
   retained video jobs. Storage, site authorization and product credit checks
   remain prerequisites for media generation.
7. For images, reuse `MICROSOFT_AZURE_OPENAI_ENDPOINT` and
   `MICROSOFT_AZURE_OPENAI_API_KEY` (or `AZURE_OPENAI_ENDPOINT` and
   `AZURE_OPENAI_API_KEY`). Optional `AZURE_OPENAI_IMAGE_ENDPOINT` /
   `AZURE_OPENAI_IMAGE_API_KEY` take precedence; explicit empty overrides fail
   closed. Endpoints must be HTTPS Azure resource origins or `/openai/v1/` bases.
   Set `AZURE_OPENAI_IMAGE_DEPLOYMENT=gpt-image-2.5-sunburst` and
   `AZURE_OPENAI_IMAGE_API_VERSION=preview`. `v1` and dated image API versions
   are supported explicitly; dated versions use `/openai/deployments/...`.
   The generic chat deployment and API version are deliberately not inherited.
   Remove stale `OPENROUTER_IMAGE_MODEL` / `OPENROUTER_IMAGE_PROVIDER`; they cannot
   redirect image traffic. No new Azure resource or deployment is created.

Direct image requests use Azure credentials and Azure billing, not OpenRouter
credits or BYOK. Azure invoices/usage still require validation; application credits
remain separate. For the other capabilities, using OpenRouter credits bills
OpenRouter; selecting an Azure provider does **not**
automatically use this application's Azure subscription. To use your Azure
subscription, configure Azure BYOK in OpenRouter and validate support for each
model/endpoint. Check BYOK fees, regional routing, data retention and fallback
settings in OpenRouter. In particular, disallow shared-capacity fallback there
if requests must stay on your own Azure credentials.

## Errors, visibility and billing

AI text, video, speech and transcription requests use OpenRouter and reject
direct provider overrides (`azure`, `gemini`, `vercel`); model vendors are selected
with qualified OpenRouter IDs. Image endpoints accept only Azure direct.
Legacy provider keys/endpoints are not fallback credentials. Scrapybara supplies
sandbox tools, not the hosted model for plan execution. Separate telephony
platform integrations (Zavu/Vapi) are not replaced by this generation gateway.
Specialized `AI_CODE_MODEL`, `AI_VISUAL_MODEL`, `AI_VISUAL_FALLBACK_MODEL` and
`INSTANCE_CONTEXT_SUMMARY_MODEL` overrides still select models through OpenRouter;
leave them unset to use the central chat default.

Keep returned usage metadata and generation IDs when available. A missing cost
is unknown, not a free generation. Azure image usage tokens are not currency and
are not represented as an invented dollar cost. OpenRouter activity/logs provide provider-side
visibility. Product credits remain the application's existing pricing policy,
not a promise to bill customers exactly OpenRouter's invoice cost.
Image asset metadata identifies `cost_scope=generation`: when one request returns
multiple images, do not sum the repeated request cost across its assets.
Likewise, tool logs can carry their parent step's accounting snapshot. Aggregate
by generation ID, not by summing every log row. Broader legacy command billing
continues to use token-based product pricing; this migration is not a billing rewrite.

The historical status key `ai_portkey` is retained for stored health-history
compatibility, but its display label and probe now refer to OpenRouter.

## Asynchronous video

`POST /api/ai/video` with `site_id` and a prompt returns a retained local `job_id`
and `status` (`pending`, `in_progress`, `completed`, `failed`). Empty `videos`
while pending does not mean success with a finished artifact.

Poll `GET /api/ai/video?site_id=...&job_id=...` using the same authorized site.
The generation service/tool can also resume using `job_id`. Do not submit a new
generation to poll an existing job. Job ownership is stored server-side in
Upstash for seven days; upstream polling/download URLs are not trusted for
credential forwarding.

Ambiguous submit or credit-deduction outcomes require reconciliation rather than
automatic resubmission/rebilling. The existing credit RPC has no idempotency key;
the integration therefore records billing intent and fails closed on uncertain
outcomes. Video output is temporarily retained by the upstream asynchronous API;
OpenRouter documents video as incompatible with strict ZDR enforcement.

## Future user-owned accounts (not enabled by this migration)

The shared client accepts a server-resolved explicit credential and creates a
fresh instance per call; an explicit empty credential never falls back to the
platform key. This is groundwork, **not** user OAuth or tenant billing.

Before enabling user accounts, implement OAuth/PKCE, encrypted credential storage,
tenant authorization and revocation, per-account limits, and credential ownership
on asynchronous jobs. Do not accept an arbitrary API key or upstream URL from a
public request body. Do not reuse a platform-owned job with a different account.
Disable fallback to the platform account when a user's budget/key fails.

## Validation

Run `npm run test:ai` for offline adapter/routing contracts. Tests mock provider
responses and generate synthetic credentials using `node:crypto`; they never
load developer environment files or incur inference charges. Run the harness and
voice regressions as appropriate before deployment.
Run a fresh production build before deployment so the ignored, generated
`.well-known/workflow` bundles are rebuilt from the migrated source. Old generated
bundles on disk can still contain Portkey/Gemini code; they are not source files
to patch manually.

Production acceptance still requires authenticated smoke tests: Spanish TTS names,
brands and prices; pronunciation and latency; streamed tool-call round trips and
reasoning replay; valid 1536-dimensional embeddings; image/reference generation;
video submit/resume/download and billing; transcription; error/budget behavior.
No authenticated live inference is part of the offline tests.

## Official references

- [Models and capabilities](https://openrouter.ai/docs/guides/overview/models)
- [Azure BYOK](https://openrouter.ai/docs/guides/overview/auth/byok)
- [Activity and costs](https://openrouter.ai/docs/guides/features/activity)
- [Spend controls](https://openrouter.ai/docs/guides/best-practices/spend-controls)
- [User OAuth/PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
- [Image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [Direct Azure image generation and editing](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e)
- [Video generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Text-to-speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts)
