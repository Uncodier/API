# Gear channel project routing

WhatsApp and email use the same current `site_user_has_effective_access` policy
for project discovery and `instance_project` list/set. Raw membership presence
is not authorization: suspended/expired licenses, inactive or manually disabled
members and archived sites are excluded by the canonical SQL policy.

- Keep the saved project only when it is currently accessible and the session
  belongs to the authenticated actor.
- If the saved project is unavailable and one authorized project remains, select
  it and clear the previous instance binding before resolving its own instance.
- If several remain, use the Gear lobby to ask which project to select. The lobby
  must not reuse the unavailable project's history or perform its actions.
- If none remain, use the lobby to explain that access/licenses need review in
  the web app. Do not claim that the user necessarily has never created a project.
- Authorization/query outages fail closed without changing the saved project.
- Setting a project rechecks access and clears the previous instance binding.

The WhatsApp account-SID fallback is not a project authorization mechanism and
must not select a business project outside the authenticated actor's choices.
The configured Gear site remains only the existing registration/lobby context.

## Session storage

The deployed `remote_sessions` table has a unique, non-null `phone_number`
column and no `email` column. WhatsApp keeps its normalized phone key. Email
stores a separate `email:<trimmed-lowercase-address>` key in that same column.
Both the email handler and project-selection tool use the shared session helper;
no schema migration or changes to existing WhatsApp rows are required.
Session identity comes from the authenticated channel, never tool arguments.
Session write failures do not report successful project selection.

This change handles project access, not credit-based automatic switching. A
project with valid access but no credits remains subject to the billing guards;
do not silently spend another project's credits.

Offline verification:

```sh
node ./node_modules/jest/bin/jest.js --config jest.ai.config.js --runInBand --testPathPatterns='gear/whatsapp/webhook'
```

`project-routing.test.ts` exercises the real WhatsApp/email handlers and shared
project tool against an explicit mocked database, without provider sends or
production session mutations. The mock validates real session columns and the
unique conflict key, applies session writes, and checks lobby selection followed
by the next message for both channels.