import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { withPlatformScope, type PlatformHandler, type PlatformHandlerResult } from './with-platform-scope';
import { lintMigration } from '@/lib/services/apps-platform/migration-linter';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

/**
 * Platform API handlers. Each handler is a thin gateway over an existing
 * Uncodie service — it validates tenant context + scope (already done by
 * `withPlatformScope`) and then delegates. Never invents payloads.
 *
 * Registered in the table at the bottom; the `[...path]/route.ts` catch-all
 * looks up the path+method combination here.
 */

type HandlerKey = `${string} ${string}`; // "POST email/send"

async function jsonBody(req: NextRequest): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

/** GET /me — cheap token introspection for sandbox clients to confirm wiring. */
const getMe: PlatformHandler = async (_req, ctx): Promise<PlatformHandlerResult> => {
  return {
    status: 200,
    body: {
      site_id: ctx.site_id,
      requirement_id: ctx.requirement_id,
      scopes: ctx.scopes,
      test_only: ctx.test_only,
    },
    response_summary: { scopes_count: ctx.scopes.length },
  };
};

/** POST /tracking/event — inserts into the existing site-scoped events table. */
const postTrackingEvent: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const body = await jsonBody(req);
  const eventName = typeof body.event === 'string' ? body.event.slice(0, 80) : null;
  if (!eventName) {
    return { status: 400, body: { error: 'Missing "event" (string).' } };
  }
  const payload = {
    site_id: ctx.site_id,
    requirement_id: ctx.requirement_id,
    event_name: eventName,
    properties: (body.properties ?? {}) as Record<string, any>,
    source: 'platform-api',
    created_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin.from('platform_tracking_events').insert(payload);
  if (error) {
    return { status: 502, body: { error: `Failed to persist tracking event: ${error.message}` } };
  }
  return { status: 202, body: { accepted: true }, response_summary: { event: eventName } };
};

/** GET /leads — site-scoped lead list with a hard limit. */
const listLeads: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('id, email, name, phone, status, tags, created_at')
    .eq('site_id', ctx.site_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    return { status: 502, body: { error: `Failed to list leads: ${error.message}` } };
  }
  return { status: 200, body: { leads: data ?? [], count: data?.length ?? 0 } };
};

/** POST /leads — inserts a site-scoped lead. */
const createLead: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const body = await jsonBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
  if (!email) {
    return { status: 400, body: { error: 'Missing "email".' } };
  }
  const payload: Record<string, any> = {
    site_id: ctx.site_id,
    email,
    name: typeof body.name === 'string' ? body.name.slice(0, 200) : null,
    phone: typeof body.phone === 'string' ? body.phone.slice(0, 40) : null,
    status: typeof body.status === 'string' ? body.status.slice(0, 40) : 'new',
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 20).map(String) : [],
    metadata: { source: 'platform-api', requirement_id: ctx.requirement_id, ...(body.metadata ?? {}) },
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin.from('leads').insert(payload).select('id').maybeSingle();
  if (error) {
    return { status: 502, body: { error: `Failed to insert lead: ${error.message}` } };
  }
  return { status: 201, body: { id: data?.id, email } };
};

/** POST /notifications — creates an in-app notification entry for the site. */
const createNotification: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const body = await jsonBody(req);
  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : null;
  if (!title) return { status: 400, body: { error: 'Missing "title".' } };
  const payload = {
    site_id: ctx.site_id,
    title,
    body: typeof body.body === 'string' ? body.body.slice(0, 4000) : '',
    level: typeof body.level === 'string' ? body.level.slice(0, 20) : 'info',
    metadata: { source: 'platform-api', requirement_id: ctx.requirement_id, ...(body.metadata ?? {}) },
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin.from('notifications').insert(payload).select('id').maybeSingle();
  if (error) {
    return { status: 502, body: { error: `Failed to create notification: ${error.message}` } };
  }
  return { status: 201, body: { id: data?.id } };
};

/**
 * POST /email/send — gateway over the real transactional email service. We
 * validate tenant + recipient allowlist and delegate. When the underlying
 * service is not reachable we return 501 (Not Implemented) rather than a
 * mocked success — Platform API never pretends to deliver.
 */
const sendEmail: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const body = await jsonBody(req);
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : null;
  const subject = typeof body.subject === 'string' ? body.subject.slice(0, 200) : null;
  const html = typeof body.html === 'string' ? body.html : null;
  const text = typeof body.text === 'string' ? body.text : null;
  if (!to || !subject || (!html && !text)) {
    return { status: 400, body: { error: 'Required: to, subject, and html or text.' } };
  }

  // Allowlist enforcement. test_only keys can only target leads flagged
  // is_test=true (or site owner-declared test recipients). Prod keys can
  // target any lead belonging to the site.
  const { data: lead } = await supabaseAdmin
    .from('leads')
    .select('id, email, is_test, status')
    .eq('site_id', ctx.site_id)
    .ilike('email', to)
    .maybeSingle();
  if (!lead) {
    return {
      status: 403,
      body: {
        error:
          'Recipient not found in site leads. Platform email only targets leads belonging to the active site; add the recipient to the CRM first.',
      },
    };
  }
  if (ctx.test_only && !lead.is_test) {
    return {
      status: 403,
      body: {
        error:
          'Test-only key cannot target non-test leads. Mark the recipient is_test=true or promote the scope to "email.send" from the dashboard.',
      },
    };
  }

  // Delegate to the real transactional service when available. We do NOT
  // import it unconditionally — surface a 501 with a pointer when the
  // environment is not configured, so the agent does not assume delivery.
  try {
    // Dynamic import keeps cold paths slim and avoids build-time coupling.
    const { EmailSendService } = await import('@/lib/services/email/EmailSendService');
    const service = EmailSendService as unknown as {
      sendTransactional?: (args: {
        site_id: string;
        to: string;
        subject: string;
        html?: string | null;
        text?: string | null;
        metadata?: Record<string, any>;
      }) => Promise<{ delivered: boolean; id?: string; error?: string }>;
    };
    if (!service?.sendTransactional) {
      return {
        status: 501,
        body: {
          error:
            'EmailSendService.sendTransactional not available in this environment — platform email is not mocked, configure the service first.',
        },
      };
    }
    const result = await service.sendTransactional({
      site_id: ctx.site_id,
      to,
      subject,
      html,
      text,
      metadata: { requirement_id: ctx.requirement_id, posture: ctx.test_only ? 'test-only' : 'prod' },
    });
    return {
      status: result.delivered ? 202 : 502,
      body: result,
      response_summary: { to, subject, delivered: result.delivered },
    };
  } catch (e: unknown) {
    return {
      status: 501,
      body: {
        error: `Email send capability not wired: ${e instanceof Error ? e.message : 'unknown'}. No mocked success returned.`,
      },
    };
  }
};

/**
 * POST /db/migrations — applies tenant-scoped SQL through the Apps Supabase
 * service client AFTER passing the migration linter. Strictly bound by:
 *   - tenant id in the JWT,
 *   - schema `app_<requirement_id>`,
 *   - linter ruleset (no public.*, no auth.*, no role/extension/grant, RLS
 *     required on every new table.
 */
const applyMigration: PlatformHandler = async (req, ctx): Promise<PlatformHandlerResult> => {
  const body = await jsonBody(req);
  const sql = typeof body.sql === 'string' ? body.sql : null;
  if (!sql || sql.trim().length === 0) {
    return { status: 400, body: { error: 'Required: { sql: string }.' } };
  }
  const requirementId = ctx.requirement_id;
  if (!requirementId) {
    return { status: 403, body: { error: 'API key not bound to a requirement; cannot resolve tenant schema.' } };
  }
  const apps = getAppsAdminClient();
  const { data: tenant } = await apps
    .from('apps_tenants')
    .select('tenant_id, schema, bucket')
    .eq('requirement_id', requirementId)
    .maybeSingle();
  if (!tenant) {
    return { status: 409, body: { error: 'Tenant not provisioned. Run ensureTenant from the workflow first.' } };
  }
  const lint = lintMigration({
    sql,
    schema: tenant.schema as string,
    tenant_id: tenant.tenant_id as string,
    bucket: tenant.bucket as string,
  });
  if (!lint.ok) {
    return {
      status: 422,
      body: { error: 'Migration rejected by linter.', issues: lint.errors },
      response_summary: { errors: lint.errors.length },
    };
  }
  try {
    const { error } = await apps.rpc('apps_exec_sql', { sql });
    if (error) {
      return { status: 502, body: { error: `Migration apply failed: ${error.message}` } };
    }
  } catch (e: unknown) {
    return {
      status: 501,
      body: {
        error: `apps_exec_sql RPC not available in this project: ${e instanceof Error ? e.message : 'unknown'}.`,
      },
    };
  }
  return {
    status: 200,
    body: { applied: true, schema: tenant.schema, warnings: lint.warnings },
    response_summary: { schema: tenant.schema, statements: sql.split(';').filter((s) => s.trim()).length },
  };
};

const TABLE: Record<HandlerKey, { scope: string; handler: PlatformHandler; endpoint: string }> = {
  'GET me': { scope: 'tracking.event.write', handler: getMe, endpoint: '/api/platform/me' },
  'POST tracking/event': { scope: 'tracking.event.write', handler: postTrackingEvent, endpoint: '/api/platform/tracking/event' },
  'GET leads': { scope: 'leads.read', handler: listLeads, endpoint: '/api/platform/leads' },
  'POST leads': { scope: 'leads.write', handler: createLead, endpoint: '/api/platform/leads' },
  'POST notifications': { scope: 'notifications.create', handler: createNotification, endpoint: '/api/platform/notifications' },
  'POST email/send': { scope: 'email.send.test-only', handler: sendEmail, endpoint: '/api/platform/email/send' },
  'POST db/migrations': { scope: 'db.migrate', handler: applyMigration, endpoint: '/api/platform/db/migrations' },
};

export function resolveHandler(method: string, pathSegments: string[]): {
  scope: string;
  endpoint: string;
  handler: PlatformHandler;
} | null {
  const joined = pathSegments.join('/');
  const key = `${method.toUpperCase()} ${joined}` as HandlerKey;
  return TABLE[key] ?? null;
}

export function wrapWithScope(entry: { scope: string; endpoint: string; handler: PlatformHandler }) {
  return withPlatformScope({
    scope: entry.scope,
    endpoint: entry.endpoint,
    handler: entry.handler,
  });
}
