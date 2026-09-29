# Requirement tracking site — 2026-09-28

## Required behavior

Generated applications use the existing `requirements.site_id` for browser
tracking and preview-domain authorization. Running an app requirement must not
create another Makinari site, add members, change ownership, or overwrite the
existing site's tracking settings.

`ensureRequirementTrackingSite` retains its historical name but is read-only:
it checks the requirement's site against the workflow's expected site, verifies
that the site exists, and returns that ID. Missing or mismatched sites fail
closed; there is no create-on-missing fallback. Preview domains use the same
resolver and the `(site_id, domain)` conflict key.

## Verified incident

- Commit `ddb3c58f` (September 28, 12:07:15 UTC−06:00) introduced a deterministic
  site per requirement, replacing the existing requirement-site tracking ID.
- NEX CARGO requirement `5a1d6caa-92a4-420d-80f2-567392a1af11` belongs to site
  `32d91d80-7ab4-461d-a5ee-86564077f41b` (Ofertas en Camino).
- The old provisioner created site `09307f98-026e-580b-afd5-ab129b5e9f0b` at
  `2026-09-28T22:34:14.639491Z`. Its name came from the requirement title and
  its owner from the original site; its URL was null.
- The instance infrastructure log at `2026-09-28T22:34:15.173149Z` confirms the
  tracking-script upgrade using that generated ID. There were no `site_members`
  rows for the new site. The `sites` ownership trigger populated `site_ownership`,
  and the frontend listed it as an ordinary owned project.

## Rollout and existing data

Deploy the API change before expecting new workflow executions to use the
corrected resolver. The existing tracking-script transformer replaces a legacy
generated site ID with the verified requirement site when that step next runs;
publishing the updated application still requires its normal delivery workflow.
Preview status synchronization registers domains on the requirement site even
when the preview URL has not changed.

This correction does not delete previously generated sites or domains, transfer
visitor data, alter Apps tenants, or update already published applications.
Inspect references and retained telemetry before any separate production cleanup.
No production data was changed as part of this code correction.