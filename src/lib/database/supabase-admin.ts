import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * PostgREST base URL for the **service role** client (server/cron, `supabaseAdmin`).
 * If unset, falls back to `NEXT_PUBLIC_SUPABASE_URL`.
 *
 * Use the default `https://<project-ref>.supabase.co` here when
 * `NEXT_PUBLIC_SUPABASE_URL` is a custom domain whose PostgREST lags the schema
 * (e.g. `42703` on new columns) while the project-ref URL is correct.
 * Server-only — not exposed to the browser.
 */
export function getSupabaseServiceRoleUrl(): string {
  return process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
}

type GatewayReply = { baseUrl: string; projectHeader: string | null };
export type AskPolicyRpc = 'connector_ask_policy_status' | 'connector_set_ask_policy';
type ActorRpc = 'connector_catalog_read_actor' | 'connector_direct_actor' | AskPolicyRpc;
type Capture = { rpc: ActorRpc; open: boolean; calls: number; reply: GatewayReply | null };
const actorCapture = new AsyncLocalStorage<Capture>();

/** Internal transport boundary. The callback must return the exact actor RPC's boolean result. */
async function captureActorReply(rpc: ActorRpc, check: () => Promise<boolean>) {
  const capture: Capture = { rpc, open: true, calls: 0, reply: null };
  try {
    const allowed = (await actorCapture.run(capture, check)) === true;
    return { allowed, reply: allowed && capture.calls === 1 ? capture.reply : null };
  } finally {
    capture.open = false; // Detached work must not keep capturing after the check settles.
    capture.reply = null;
  }
}

export const captureCatalogActorReply = (check: () => Promise<boolean>) => captureActorReply('connector_catalog_read_actor', check);
export const captureDirectActorReply = (check: () => Promise<boolean>) => captureActorReply('connector_direct_actor', check);
export const captureAskPolicyReply = (rpc: AskPolicyRpc, check: () => Promise<boolean>) => captureActorReply(rpc, check);

// Private to admin client construction. Never reread an origin from the environment at request time.
function adminFetch(baseUrl: string): typeof fetch {
  const actorBase = `${baseUrl.replace(/\/$/, '')}/rest/v1/rpc/`;
  return async (input, init) => {
    const capture = actorCapture.getStore();
    const actorUrl = capture && actorBase + capture.rpc;
    // postgrest-js passes a string URL and Headers; do not reinterpret other request shapes.
    if (!capture?.open || input !== actorUrl || init?.method !== 'POST' ||
        !(init.headers instanceof Headers) || init.headers.get('content-profile') !== 'public') {
      return fetch(input, init);
    }
    capture.calls++;
    const res = await fetch(input, { ...init, redirect: 'error', cache: 'no-store' });
    if (capture.open && res.status === 200 && res.redirected === false && res.url === actorUrl) {
      capture.reply = { baseUrl, projectHeader: res.headers.get('sb-project-ref') };
    }
    return res; // The normal SDK parses the body; access.ts must have observed error-free boolean true.
  };
}

let admin: SupabaseClient | undefined;
export function getSupabaseAdmin(): SupabaseClient {
  if (!admin) {
    const baseUrl = getSupabaseServiceRoleUrl();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!baseUrl || !key) {
      throw new Error('The server Supabase URL and service role key are required for this operation.');
    }
    admin = createClient(baseUrl, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: adminFetch(baseUrl) },
    });
  }
  return admin;
}
