# OpenRouter images: rollback and future acceptance gate

Status: experimental adapter withdrawn at the user's request; not deployed.
Evidence date: 2026-11-10. This is a decision record, not an enabled integration.

## Restored runtime

Image generation uses **Azure directly**, as before the OpenRouter experiment.
The image API, service wrappers, ordinary agent tools, and SDK tools accept Azure
only. Explicit OpenRouter image requests are rejected. Existing storage,
authorization, rate limits, credit reservations, settlement, and uncertain-outcome
handling remain unchanged. No automatic gateway/account fallback is enabled.

The image deployment is `AZURE_OPENAI_IMAGE_DEPLOYMENT`, defaulting to
`gpt-image-2.5-sunburst`. Endpoint/key resolution first considers image-specific
variables, then the existing general Azure variables. Sharing a resource endpoint
and key does not mean sharing the chat deployment.

No environment variables, Azure resources, OpenRouter BYOK settings, historical
charges, or remote database objects were changed by this rollback. The failed
live probes did not upload images or execute Makinari credit RPCs. Chat,
embeddings, and video retain their pre-experiment OpenRouter behavior.

## What the experiment established

- Sunburst 2.5 is configured in the local direct-Azure image setup. The user
  confirmed Sunburst is the production image deployment; production credentials
  and effective deployed configuration were not independently inspected.
- OpenRouter's public image catalog listed Sunburst with provider `openai`, not
  `azure`. A working direct-Azure Sunburst deployment is not proof that OpenRouter
  supports that same deployment or credential through Azure BYOK.
- MAI-Image-2.6 is a different model. OpenRouter listed it with provider `azure`.
  A screenshot showed an Azure Foundry MAI endpoint and matching resource name;
  selecting MAI in a BYOK filter does not convert a Sunburst deployment into MAI.
- Initial live Sunburst/MAI requests failed with HTTP 402. A MAI response explicitly
  stated that the OpenRouter account had never purchased credits. Those responses
  alone did not prove an invalid Azure key or that BYOK was ignored.
- A later MAI request failed with `Azure MAI image upstream returned 530`.
  The user's OpenRouter log showed **Key Type: BYOK**, with two internal Azure
  attempts, first 404 and then 530. Our caller sent one generation POST.
- Those logs confirm BYOK selection, not successful authentication/generation.
  They do not identify which Azure resource/key produced each attempt. Do not
  assign the attempts to West or Sweden without per-attempt evidence.
- `provider.only: ["azure"]` and `allow_fallbacks: false` did not prevent two
  internal Azure attempts. Provider restriction is not proof of a single BYOK key
  or resource attempt; shared-capacity settings and key filters matter separately.
- No live probe produced an image. The 530 cause remains unresolved. Do not
  assert DNS failure, bad credentials, a region problem, or a provider outage
  from that status alone. Passing offline tests did not establish live readiness.

## Future OpenRouter integration may still support images

Images are not permanently excluded from the customer-owned OpenRouter design.
However, **do not enable image tasks from catalog discovery or an AI recommendation
alone**. An implemented adapter and a successful end-to-end capability verification
with the actual authorized connection are mandatory before enabling the route.

For each candidate connection/model/provider configuration:

1. Validate model identity, actual serving endpoint, key filters, account/workspace,
   and required formats/parameters. Catalog membership is only candidate evidence.
2. Verify credentials belong to the intended resource. Never assume direct Azure
   credentials are inherited by OpenRouter or that a native subscription is API credit.
3. Keep image capability disabled/unverified until an explicitly authorized,
   bounded real generation succeeds. Use synthetic prompts and no business tools.
4. Require a complete successful response, a decodable image, and compatible
   dimensions/format. HTTP 200 with an error, empty output, or malformed bytes fails.
5. Validate persistence and payer attribution before accepting the application
   path. When BYOK-only is required, require evidence of BYOK routing, not just a
   model/vendor name, zero cost, or an OpenRouter credential being present.
6. Scope verification to connection revision, model, endpoint policy, and adapter
   version. New/changed image configurations need verification; refresh and manual
   selections cannot bypass this gate or silently change payer/provider.
7. A failed probe preserves other working routes and records a clear reason.
   Do not retry indefinitely or replace direct-Azure production behavior.

Confirmed customer-funded image calls may be exempt from Makinari inference
credits once the planned payer-aware integration exists. The restored platform
Azure route retains its existing billing; no exemption has been implemented.

## Validation boundary

Rollback validation checks source equality with the pre-experiment tracked image
files, absence of removed adapter references, focused offline Azure/image/service
regressions, and TypeScript. Broader unrelated working-tree changes are preserved.
No further paid generation, deployment, push, or remote migration is part of rollback.

Related design: [customer OpenRouter integration](/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/docs/OPENROUTER_INTEGRATION_DESIGN.md).
