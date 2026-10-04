# OpenRouter migration

## Runtime direction

OpenRouter handles text, agents, embeddings and video, without
Portkey in between. **Image generation, text-to-speech and transcription use Azure directly**,
using existing server credentials; TTS requires its dedicated endpoint and key.
The existing OpenAI SDK is reused for compatible OpenRouter endpoints; video uses
its dedicated API. Gateway, model vendor and Azure deployment names are distinct.

| Capability | Default / required selection |
| --- | --- |
| Chat and agent tools | `OPENROUTER_CHAT_MODEL`, default `openai/gpt-6.1-sol` |
| Embeddings | `openai/text-embedding-3-small`, 1536 dimensions by default |
| Image generation | Azure direct: `AZURE_OPENAI_IMAGE_DEPLOYMENT`, default `gpt-image-2.5-sunburst` |
| Video generation | Explicit `OPENROUTER_VIDEO_MODEL` required |
| Text to speech | Azure direct: `AZURE_TTS_DEPLOYMENT`, default `tts-hd` |
| Speech API version | `AZURE_TTS_API_VERSION`, default `2025-04-01-preview` |
| Speech voice | `AZURE_TTS_VOICE`, default `alloy` (multilingual Azure OpenAI voice) |
| Transcription | Azure direct: required `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT` (existing deployment: `gpt-transcribe`) |

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

Public OpenRouter catalog inspection found `openai/sora-2-pro`, not the selected
Sora 2 base. The OpenRouter catalog does not determine the availability of the
direct Azure TTS deployment. The code must not silently replace the video
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
4. For speech, configure the existing dedicated `AZURE_TTS_ENDPOINT` and
   `AZURE_TTS_API_KEY` in the server secret store. Set optional
   `AZURE_TTS_DEPLOYMENT=tts-hd`, `AZURE_TTS_API_VERSION=2025-04-01-preview` and
   `AZURE_TTS_VOICE=alloy`, or omit them to use these defaults. Do not set empty
   overrides. TTS does not inherit the chat deployment/API version or other
   Azure credentials, and has no OpenRouter fallback. Remove stale
   `OPENROUTER_TTS_MODEL` / `OPENROUTER_TTS_VOICE`; they are ignored. Old
   `AI_TTS_PROVIDER` and `AI_TRANSCRIPTION_PROVIDER` environment settings cannot
   redirect traffic. See the direct TTS contract below.
5. Select the video model explicitly after checking the current catalog and pricing.
   For voice-note ingestion, set `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT=gpt-transcribe`
   on the existing Azure resource. Transcription does not use OpenRouter's catalog,
   credentials or `OPENROUTER_TRANSCRIPTION_MODEL`. See the direct transcription contract below.
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

Direct image, TTS and transcription requests use Azure credentials and Azure billing, not OpenRouter
credits or BYOK. Azure invoices/usage still require validation; application credits
remain separate. For OpenRouter capabilities, using OpenRouter credits bills
OpenRouter; selecting an Azure provider does **not**
automatically use this application's Azure subscription. To use your Azure
subscription, configure Azure BYOK in OpenRouter and validate support for each
model/endpoint. Check BYOK fees, regional routing, data retention and fallback
settings in OpenRouter. In particular, disallow shared-capacity fallback there
if requests must stay on your own Azure credentials.

## Direct Azure text-to-speech

- `AZURE_TTS_ENDPOINT` must be an HTTPS Azure resource origin or an
  `/openai/v1/` base, not a full speech/deployment URL. Do not include credentials,
  query parameters or fragments in the endpoint. The adapter resolves either
  accepted base to the dated Azure OpenAI API:
  `POST /openai/deployments/{deployment}/audio/speech?api-version=2025-04-01-preview`
  by default. A `/openai/v1/` base does **not** select the v1 speech API.
- `AZURE_TTS_DEPLOYMENT` names an Azure deployment, not an OpenRouter model ID.
  The existing resource and selected deployment must actually host a compatible
  Azure OpenAI TTS model. An image/chat deployment or a deployment merely named
  `tts-hd` is not proof of TTS support. This change creates no new Azure resource
  or deployment; verify the existing deployment's model, region and access before
  rollout.
- Use Azure OpenAI multilingual voices, with `alloy` as the default. Spanish text
  uses these voices too; MAI voice IDs are not valid for this integration.
  Verify supported voices against the selected TTS
  deployment before changing them.
- `generate_audio` exposes `voice` (`auto`, `alloy`, `echo`, `fable`, `onyx`, `nova`,
  `shimmer`) and `language` (`auto` or a listed ISO 639-1 code). Both selectors
  default to `auto`: the agent may choose a suitable voice and infer the language
  from the request/context. If the agent leaves voice unset, the configured Azure
  voice remains the final fallback; `auto` is never sent as an Azure voice ID.
  Content Creator selections are preserved as authoritative tool overrides;
  resetting to Auto removes stale forced selections.
- Language is text-preparation guidance, not an Azure `tts-hd` request field.
  The agent must write or translate the spoken content into the selected language
  **before** calling `generate_audio`. The adapter validates language choices but
  neither translates text nor sends unsupported language/instruction fields to
  Azure. Direct `/api/ai/audio` callers must supply text already in that language.
  `X-TTS-Text-Language` describes requested text-language guidance, not a detected
  or verified language. Only the intended spoken content is synthesized.
- Supported response formats are `mp3` (default), `pcm`, `wav`, `opus`, `aac` and
  `flac`. Input is limited to 4,096 characters; speed must be between `0.25` and
  `4`, inclusive. Unsupported formats and out-of-range inputs are rejected, not
  silently substituted or sent to another provider.
- Missing or invalid dedicated configuration fails closed. There is no chat
  deployment/version inheritance, generic Azure credential inheritance or
  OpenRouter fallback. Transcription uses its separate direct Azure configuration below.
- The system-status workflow reads `AZURE_TTS_ENDPOINT` and `AZURE_TTS_API_KEY`
  from dedicated GitHub secrets. Optional GitHub variables `AZURE_TTS_DEPLOYMENT`,
  `AZURE_TTS_API_VERSION` and `AZURE_TTS_VOICE` use explicit defaults when unset
  or empty, so missing repository variables do not inject invalid empty overrides.

### Live validation (2026-10-04)

1. The initially configured dedicated endpoint returned HTTP 200 with an empty
   deployment list (`api-version=2023-03-15-preview`). One minimal speech request
   to `tts-hd` with `api-version=2024-10-21`, input `Hola.` and voice `alloy`
   returned HTTP 404 in 878 ms (error code `404`), with no audio.
2. A read-only query on the existing `MICROSOFT_AZURE_OPENAI_ENDPOINT`, with its
   matched key, returned HTTP 200 and 28 deployments, including deployment
   `tts-hd`, model `tts-hd`, with status `succeeded`. The local dedicated TTS
   endpoint/key were then explicitly repointed to that existing matched resource;
   this is configuration, not runtime credential fallback. An adapter smoke test
   still returned HTTP 404 with the dated `2024-10-21` API version.
3. With `AZURE_TTS_API_VERSION=2025-04-01-preview`, the real adapter call
   `synthesizeSpeech({ text: 'Hola, tu pedido cuesta 250 pesos.', format: 'mp3' })`
   succeeded using the default `tts-hd` deployment and `alloy` voice: `audio/mpeg`,
   70,739 bytes, a valid MP3 signature and 2,881 ms latency.

**Successful direct Azure TTS inference was performed.** No storage uploads,
database charges, new resources or new deployments were made by this check.
This validates one adapter/deployment/version/format combination, not a production
deployment or subjective Spanish pronunciation quality. Server and CI environment
configuration must use the matched speech resource endpoint/key and the validated
`2025-04-01-preview` speech API version; local configuration changes do not deploy
those settings. Production acceptance still requires pronunciation review,
representative names/brands/prices, latency and format coverage, end-to-end
storage/billing checks and Azure usage reconciliation.

### Production 404 investigation

A subsequent `generate_audio` call returned `502` with
`Azure TTS request failed (404)`. The running local API successfully synthesized
the same four-line Spanish verse (HTTP 200, `X-TTS-Provider: azure`, valid MP3,
199,859 bytes in 4,764 ms). The production environment still pointed its dedicated
TTS endpoint/key at the original resource without the speech deployment; the
generic production Azure credentials matched the locally verified resource.

The production-only `AZURE_TTS_ENDPOINT` and `AZURE_TTS_API_KEY` were explicitly
updated to that existing matched resource, with deployment `tts-hd`, API version
`2025-04-01-preview` and voice `alloy`. A redeploy of the already-published
production version completed; it did not include unrelated uncommitted local
changes. The production alias was verified to point to the new ready deployment
before inference. The same four-line verse then succeeded on production
`POST /api/ai/audio`: HTTP 200, `X-TTS-Provider: azure`, `audio/mpeg`, 194,099 bytes
with a valid MP3 signature in 5,210 ms. This check did not rerun the original agent
node, upload an asset or deduct application credits; those end-to-end steps and
subjective pronunciation validation remain separate acceptance checks.
Sensitive Vercel variables are not returned by environment pulls; an omitted
secret in that readback is not an empty deployed value.

The `provider: openrouter` in an assistant-tool-call event describes the model
that requested the tool, not the provider used for speech synthesis. The audio
response header and the direct Azure adapter identify the TTS provider.

## Direct Azure transcription

- Required deployment: `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT`. Reuse the existing
  `MICROSOFT_AZURE_OPENAI_ENDPOINT` and `MICROSOFT_AZURE_OPENAI_API_KEY`, or generic
  `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY`. Dedicated
  `AZURE_OPENAI_TRANSCRIPTION_ENDPOINT` / `AZURE_OPENAI_TRANSCRIPTION_API_KEY`
  override those credentials; explicitly empty overrides fail closed.
- Endpoints accept HTTPS Azure resource origins or `/openai/v1/` bases, without
  userinfo, query parameters or fragments. Never inherit the chat deployment/version.
  `AZURE_OPENAI_TRANSCRIPTION_API_VERSION` defaults to `2024-10-21` and uses
  `POST /openai/deployments/{deployment}/audio/transcriptions`. Explicit `v1` or
  `preview` selects `/openai/v1/audio/transcriptions` instead.
- Upload original audio bytes with multipart `file`, `model` and `response_format=json`;
  do not route base64 audio through OpenRouter. The file must be non-empty and at
  most 25 MiB. Unknown MIME types fail rather than being mislabeled as MP3.
- No retry or fallback to another provider/account. API keys, upstream error bodies
  and user audio are not included in adapter error logs. Preserve Azure usage and
  request IDs when available, without inventing currency costs.
- On 2026-10-04, the existing `gpt-transcribe` deployment was confirmed active by
  a read-only deployment-list request. One direct transcription of the saved
  WhatsApp OGG (6,751 bytes) returned HTTP 200 and non-empty text using the default
  dated API. No format conversion, agent replay, WhatsApp send or database write
  was performed by this check. The live check used Azure inference, not OpenRouter.
  This validates that audio/deployment pair, not all formats, deployment overrides
  or end-to-end production rollout. Health checks remain configuration-only.

## Errors, visibility and billing

AI text and video requests use OpenRouter and reject
direct provider overrides (`azure`, `gemini`, `vercel`); model vendors are selected
with qualified OpenRouter IDs. Images, speech and transcription use Azure direct only.
Legacy provider keys/endpoints are not fallback credentials. Scrapybara supplies
sandbox tools, not the hosted model for plan execution. Separate telephony
platform integrations (Zavu/Vapi) are not replaced by this generation gateway.
Specialized `AI_CODE_MODEL`, `AI_VISUAL_MODEL`, `AI_VISUAL_FALLBACK_MODEL` and
`INSTANCE_CONTEXT_SUMMARY_MODEL` overrides still select models through OpenRouter;
leave them unset to use the central chat default.

Keep returned usage metadata and generation IDs when available. A missing cost
is unknown, not a free generation. Azure usage is not represented as an invented
dollar cost; image usage tokens are not currency. OpenRouter activity/logs provide
visibility only for requests routed through OpenRouter, not direct Azure TTS,
transcription or images. Product credits remain the application's existing pricing policy,
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
- [Direct Azure OpenAI text-to-speech](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/text-to-speech)
- [Azure OpenAI dated API reference](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference#text-to-speech)
