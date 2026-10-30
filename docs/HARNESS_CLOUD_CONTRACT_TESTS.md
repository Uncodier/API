# Cloud file verification

The former blocked-only contracts now have executable offline implementation
coverage. See [Cloud files](CLOUD_FILES.md) for tools, requirement mode, private
storage/Git setup, rollout and limitations.

`npm run test:harness:cloud` runs tools, versioning, search, requirement filters,
authentication/download, private Git, ZIP, environment routing and actual Postgres
RPC tests. No sandbox, live credentials or production data are required.
`npm run test:harness:cloud:unit` validates the separate contract reporter.

`npm run test:harness:cloud:contracts` intentionally exits 2 and reports
`CLOUD_LIVE_VERIFICATION_REQUIRED`. The reporter is not a capability detector or
E2E runner. Local passes do not establish that migrations/configuration/deployment
have happened. List its six scenarios with
`npm run test:harness:cloud:contracts -- list`.

The scenarios remain name/content search, create/read, replace/read, patch/read
and obsolete-version conflict. Actual tests use independent hashes/bytes, durable
versions and tenant scope. Workspace canaries remain separate and are not
reclassified as no-sandbox tests.