# Secret scanning and synthetic test credentials

## Keep detection enabled

GitGuardian alerts for **Basic Auth String** and **Generic Password** identify
credential-shaped content. They are not malware findings, and these generic
detectors do not validate whether a credential actually works. Inspect each
occurrence before classifying it as test data.

Never disable these detectors or exclude whole test/documentation directories.
Real secrets can leak through fixtures too. Do not add inline scanner-ignore
markers to avoid reviewing an incident.

## Fixture policy

- Do not copy credentials from production, environment files, logs, or customers.
- Generate synthetic values inside offline tests using `randomBytes` from
  `node:crypto`. Do not persist them in tracked files or snapshots.
- Use reserved hosts such as `example.invalid` for standalone URL fixtures. Set
  `URL.username`, `URL.password`, and query parameters at runtime rather than
  committing a URL containing userinfo. Never send these fixtures to a service.
- Retain the syntax the test exercises: password assignments, authorization
  headers, provider prefixes, multiline values, and truncation boundaries.
- Generate each marker once; reuse it for the input and negative assertions.
  Assert that usernames, passwords, and tokens are individually absent. Testing
  only the absence of a combined URL can miss partially leaked credentials.
- In documentation, reference environment variables and secure configuration
  instead of supplying plausible passwords or reusable demo accounts.
- Runtime generation is for synthetic data, not for encoding, splitting, or
  disguising an existing secret. Real exposed credentials must be revoked/rotated.

## Review of commit `ca68886`

The commit introduced offline harness redaction tests containing authenticated
URLs and password assignments. These are candidates for the reported alerts;
the notification alone does not identify the exact incident occurrences.
The affected fixtures now construct synthetic values at runtime. Redaction,
source-search/pagination, and SQL visibility assertions remain in place.

The strengthened URL assertions also exposed an ordering issue: email redaction
could consume a URL's `@` before userinfo redaction, leaving its username visible.
The shared harness sanitizer now removes userinfo first, with HTTP and HTTPS
regression coverage.

Run the offline regressions with `npm run test:harness`. They require no live
provider calls or database credentials and use in-memory PGlite for SQL tests.
They do not substitute for a GitGuardian scan.

## Existing incidents and verification

1. Open each incident in the GitGuardian dashboard and confirm its repository,
   commit, path, and every occurrence. Do not paste the detected value into an
   issue or a public discussion.
2. If every occurrence is confirmed synthetic, use the dashboard's ignore action
   with the appropriate test/false-positive reason and record the fixing commit.
   If any occurrence is real or uncertain, investigate and revoke/rotate it;
   deleting it from the current branch alone is not remediation.
3. Publish the fix through the normal review process and verify the resulting
   GitGuardian check. Local Jest success is not proof of a clean scanner result.
4. Handle the old incident explicitly: a new commit does not erase Git history
   or automatically classify an existing alert. Do not force-push rewritten
   history solely to suppress synthetic-fixture alerts.

Scanner authentication and dashboard access are external prerequisites. A local
CLI ignore file is not a replacement for reviewing incidents in the dashboard.

References: [Basic auth string detector](https://docs.gitguardian.com/secrets-detection/secrets-detection-engine/detectors/generics/basic_auth_string),
[Generic password detector](https://docs.gitguardian.com/secrets-detection/secrets-detection-engine/detectors/generics/generic_password),
and [CLI/dashboard interactions](https://docs.gitguardian.com/ggshield-docs/configuration).