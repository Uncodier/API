<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Secret-safe tests and documentation

- Never commit real credentials, even in tests, examples, logs, or snapshots.
- In offline redaction/authentication tests, generate synthetic credential values at runtime with `node:crypto`; construct authenticated URLs with `URL` setters on reserved test hosts.
- Preserve assertions that each sensitive value is absent after redaction; do not replace security inputs with already-redacted text or drop coverage to avoid an alert.
- Never encode or split a real secret to hide it from scanning. Do not disable detectors or exclude entire test/documentation directories.
- See [secret-scanning policy and incident handling](docs/SECRET_SCANNING.md). A new commit does not remove historical GitGuardian incidents.
