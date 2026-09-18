# Visitor identity OTP

The website chat uses an expiring email challenge before an existing lead can
access prior conversations from an untrusted visitor session.

## Deployment

1. Configure `VISITOR_IDENTITY_OTP_HMAC_SECRET` with at least 32 random
   characters. Keep it server-side and stable across deployments.
2. Configure the existing SendGrid variables used by
   `src/lib/services/sendgrid-service.ts`.
3. Apply both migrations in order:
   `20260917210000_visitor_identity_verification.sql`, then
   `20260917233000_visitor_identity_verification_hardening.sql`.
4. Deploy the API and the tracking Script together.

The migration creates private challenge and grant tables and service-role-only
RPCs. OTP values are never stored directly. Challenges expire after ten
minutes, lock after five failed attempts, and can be resent three times with a
60-second cooldown.

## Protected requests

Browser requests to conversations, messages, uploads, customer support, SSE,
and WebSocket endpoints must include `site_id` and `session_id`. The API derives
the canonical visitor and verified lead from that session and rejects
conversation IDs owned by another identity.

New leads receive an identity grant without an OTP. Existing leads receive an
email challenge. Canceling or logging out revokes the grant and clears the
session's lead binding.
