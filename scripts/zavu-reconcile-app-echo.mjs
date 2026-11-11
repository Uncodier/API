import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Inventory all owners before filtering connected WhatsApp connections. No fuzzy sender matching. */
export function ownedWhatsAppSenders(settings) {
  const owners = new Map();
  for (const setting of settings) {
    for (const connection of Array.isArray(setting.channels?.connections) ? setting.channels.connections : []) {
      if (!validId(connection.zavu_sender_id)) continue;
      const rows = owners.get(connection.zavu_sender_id) || [];
      rows.push({ siteId: setting.site_id, connection });
      owners.set(connection.zavu_sender_id, rows);
    }
  }
  return [...owners].flatMap(([senderId, rows]) => {
    const whatsapp = rows.filter(row => row.connection.type === 'whatsapp');
    if (!whatsapp.some(row => row.connection.status === 'connected')) return [];
    const unambiguous = new Set(rows.map(row => row.siteId)).size === 1 && whatsapp.length === 1
      && validId(whatsapp[0].siteId) && validId(whatsapp[0].connection.id);
    return [{ senderId, owned: unambiguous }];
  });
}

export function planEchoSubscription(sender, sync) {
  const webhook = sender?.webhook;
  if (!webhook || !Array.isArray(webhook.events) || webhook.events.some(event => typeof event !== 'string')
      || typeof webhook.active !== 'boolean' || typeof webhook.url !== 'string' || !webhook.url) {
    return { status: 'blocked_incomplete_webhook', patch: null };
  }
  // Do not invent/activate a webhook, rotate its secret, or subscribe the conflicting undocumented enum.
  if (webhook.events.includes('message.sent')) return { status: 'already_subscribed', patch: null };
  if (sync?.isCoexistence !== true) return { status: 'blocked_coexistence_unconfirmed', patch: null };
  return { status: webhook.active ? 'add_message_sent' : 'add_message_sent_webhook_stays_inactive',
    patch: { webhookEvents: [...webhook.events, 'message.sent'] } };
}

/** Injectable IO keeps tests entirely offline. Logs contain only allowlisted status/booleans/fingerprints. */
export async function reconcileEchoSubscriptions({ settings, request, apply = false, report = () => {} }) {
  const results = [];
  for (const { senderId, owned } of ownedWhatsAppSenders(settings)) {
    const summary = { sender: fingerprint(senderId), mode: apply ? 'apply' : 'dry-run' };
    try {
      if (!owned) {
        results.push({ ...summary, status: 'blocked_ambiguous_owner' });
        continue;
      }
      const path = `/senders/${encodeURIComponent(senderId)}`;
      const payload = await request(path);
      const sender = payload?.sender || payload;
      if (sender?.id !== senderId) throw new Error('sender_identity_mismatch');
      let sync;
      try {
        const syncPayload = await request(`${path}/whatsapp-sync`);
        sync = syncPayload?.sync || syncPayload;
      } catch { sync = null; }
      const plan = planEchoSubscription(sender, sync);
      const result = { ...summary, status: plan.status,
        webhookActive: sender.webhook?.active === true, coexistence: sync?.isCoexistence === true };
      if (apply && plan.patch) {
        // Read again just before mutation; fail closed rather than overwrite concurrent configuration edits.
        const latestPayload = await request(path);
        const latest = latestPayload?.sender || latestPayload;
        if (latest?.id !== senderId || JSON.stringify(latest.webhook) !== JSON.stringify(sender.webhook)) {
          result.status = 'blocked_config_changed';
        } else {
          await request(path, { method: 'PATCH', body: JSON.stringify(plan.patch) });
          const verifiedPayload = await request(path);
          const verified = verifiedPayload?.sender || verifiedPayload;
          const unchanged = verified?.id === senderId && verified.webhook?.url === sender.webhook.url
            && verified.webhook?.active === sender.webhook.active
            && (sender.webhook.secret === undefined || verified.webhook?.secret === sender.webhook.secret)
            && (sender.webhook.signatureVersion === undefined
              || verified.webhook?.signatureVersion === sender.webhook.signatureVersion)
            && plan.patch.webhookEvents.every(event => verified.webhook?.events?.includes(event));
          result.status = unchanged ? 'applied' : 'verification_failed_operator_review';
        }
      }
      results.push(result);
    } catch {
      // Provider/DB errors can contain credentials, authenticated URLs or message content. Never print them.
      results.push({ ...summary, status: 'request_failed_operator_review' });
    }
  }
  for (const result of results) report(result);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('invalid_arguments');
  }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const zavuKey = process.env.ZAVUDEV_API_KEY;
  if (!url || !key || !zavuKey) throw new Error('missing_environment');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const settings = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.schema('public').from('settings')
      .select('id, site_id, channels').order('id').range(offset, offset + 499);
    if (error) throw new Error('inventory_failed');
    settings.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  const request = async (path, init = {}) => {
    const response = await fetch(`https://api.zavu.dev/v1${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${zavuKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('provider_request_failed');
    return response.json();
  };
  const results = await reconcileEchoSubscriptions({ settings, request, apply: args.includes('--apply'),
    report: result => console.log(JSON.stringify(result)) });
  console.log(JSON.stringify({ senders: results.length, mode: args.includes('--apply') ? 'apply' : 'dry-run' }));
  if (results.some(result => /failed|blocked/.test(result.status))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Zavu reconciliation failed. Check environment, arguments and provider access; sensitive error details suppressed.');
    process.exitCode = 1;
  });
}