# Direct Azure image generation: diagnosing HTTP 503

`generate_image` uses the local `/api/ai/image` route for authorization, credit
validation and storage. That route calls Azure OpenAI directly. The OpenRouter
provider and generation ID on the parent assistant step identify the model that
requested the tool, not the provider that generates the image.

## Configuration failure found on 2026-10-03

The local image settings mixed an endpoint ending in
`/mai/v1/images/generations` with the `gpt-image-2.5-sunburst` deployment. The
Azure OpenAI adapter rejected that endpoint before submitting inference, returning
HTTP 503. Previously, the service discarded this safe diagnosis and exposed only
`Image API request failed (503)`.

Read-only Azure model and deployment queries returned HTTP 200 and confirmed:

- The resource selected by the dedicated image override had `MAI-Image-2.6`
  deployed, not Sunburst.
- The resource selected by `MICROSOFT_AZURE_OPENAI_ENDPOINT` had
  `gpt-image-2.5-sunburst` deployed.

The local correction removed `AZURE_OPENAI_IMAGE_ENDPOINT` and
`AZURE_OPENAI_IMAGE_API_KEY`, allowing the adapter to reuse the existing
`MICROSOFT_AZURE_OPENAI_ENDPOINT` / `MICROSOFT_AZURE_OPENAI_API_KEY` pair.
The deployment and image API version remained unchanged. No model substitution,
fallback, resource creation or paid image inference was needed for this check.

The follow-up failure persisted remotely because the production Vercel settings
still contained the dedicated `/mai/v1/images/generations` endpoint override.
Live configuration checks on both backend domains reported Azure images as not
configured while the local API remained healthy. The production Azure OpenAI
credentials successfully listed the existing Sunburst deployment. The production
endpoint/key overrides were removed and a redeploy of the existing published
source completed successfully. Both `backend.makinari.com` and
`backend.uncodie.com` then returned HTTP 200 from the live image configuration
health check, identifying `gpt-image-2.5-sunburst`. No paid image inference was
submitted by these checks. Environment changes alone do not update an already
published deployment. The router correction is a separate local source change;
redeploying the previous published source does not include it.

The tool router previously mistook the word `invalid` in a server configuration
error for an argument validation failure. Its offline regressions now ensure
configuration, admission, HTTP 5xx and uncertain generation errors do not attach
schema-retry advice. Real argument validation errors still include the schema.

## Correct configuration

- `AZURE_OPENAI_IMAGE_DEPLOYMENT` must name a deployment in the selected resource.
- The endpoint must be an HTTPS Azure resource origin or an `/openai/v1/` base,
  not a complete operation URL or a `/mai/v1/` endpoint.
- Dedicated endpoint/key overrides take precedence over existing Azure OpenAI
  settings. Use a matching pair from the same resource. Empty overrides fail
  closed; remove unused overrides rather than setting them to empty strings.
- The default image request is
  `/openai/v1/images/generations?api-version=preview`, with the deployment name
  in `model`. Generic chat deployment/version settings are not inherited.
- Apply the same correction to the actual deployment environment if needed;
  changing an ignored local environment file does not change production secrets.
  Restart/redeploy processes that loaded the old configuration.

## Distinguish failure stages

- A recognized configuration error with HTTP 503 means inference was not
  submitted by this route.
- `RATE_LIMIT_UNAVAILABLE` with HTTP 503 means application admission failed
  before inference; inspect the configured Upstash service.
- An Azure HTTP 503 is surfaced by the adapter as HTTP 502 with the safe message
  `Azure image request failed (503)`. It is not a local configuration error.
- Network timeouts have uncertain outcomes. Do not retry automatically or change
  providers: the original request may already have generated a billable image.

The service forwards only fixed, recognized application diagnostics from bounded
503 JSON bodies. Arbitrary response messages, credentials and authenticated URLs
remain hidden. Failed generation does not reach the application credit deduction.

`GET /api/ai/image/health` checks configuration only. A healthy response and a
deployment-list match do **not** prove a successful end-to-end generation, image
persistence, or Azure invoice cost.

Reference: [Azure OpenAI image generation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e).