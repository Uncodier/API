import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let mockClient: SupabaseClient;
jest.mock('@/lib/database/supabase-client', () => ({ get supabaseAdmin() { return mockClient; } }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {} }));
jest.mock('@/lib/security/upstash-rest', () => ({
  sha256: async () => 'cache-key', getCachedJson: async () => null, setCachedJson: jest.fn(),
}));

import { findActiveCustomerSupportAgent } from '@/app/api/agents/customerSupport/message/agent-data';
import { EmailProcessingService } from '../../email/EmailProcessingService';
import { findWhatsAppConfiguration } from '../../twilio/TwilioIncomingService';

const site = '00000000-0000-4000-8000-000000000001';
const phone = '+14155550106';
const support = 'Customer Support';
const legacyOr = '(configuration->>agentOrigin.is.null,configuration->>agentOrigin.neq.independent)';
type Agent = { id: string; role: string; status: string; created_at: number; user_id: string;
  configuration?: { role?: string; agentOrigin?: string | null } | null };
const independent: Agent = { id: 'custom', role: support, status: 'active', created_at: 5,
  user_id: 'custom-owner', configuration: { role: support, agentOrigin: 'independent' } };
const legacy: Agent = { id: 'legacy', role: support, status: 'active', created_at: 2, user_id: 'legacy-owner' };

// Run the real supabase-js serializer against a local fixture transport (no sockets).
function fixture(rows: Agent[], tokenAgent?: string) {
  const reads: URLSearchParams[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  mockClient = createClient('https://offline.example.test', randomBytes(32).toString('hex'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const { pathname, searchParams: q } = new URL(String(input));
      if (pathname.endsWith('/secure_tokens')) return json([{ site_id: site, identifier: phone, metadata: { agent_id: tokenAgent } }]);
      expect(pathname).toBe('/rest/v1/agents');
      expect(q.get('site_id')).toBe(`eq.${site}`);
      reads.push(q);
      let selected = rows.filter(row => (!q.has('role') || q.get('role') === `eq.${row.role}`) &&
        (!q.has('status') || q.get('status') === `eq.${row.status}`));
      if (q.has('or')) {
        expect(q.get('or')).toBe(legacyOr);
        selected = selected.filter(row => row.configuration?.agentOrigin !== 'independent');
      }
      if (q.has('configuration')) {
        expect(q.get('configuration')).toBe(`cs.${JSON.stringify({ role: support })}`);
        selected = selected.filter(row => row.configuration?.role === support);
      }
      if (q.get('order') === 'created_at.desc') selected.sort((a, b) => b.created_at - a.created_at);
      if (q.has('limit')) selected = selected.slice(0, Number(q.get('limit')));
      if (new Headers(init?.headers).get('Accept') === 'application/vnd.pgrst.object+json') {
        return selected.length === 1 ? json(selected[0]) : json({ code: 'PGRST116', message: 'Not exactly one row' }, 406);
      }
      return json(selected);
    } },
  });
  return reads;
}

it.each([undefined, null, {}, { agentOrigin: null }, { agentOrigin: 'other' }])(
  'text picks the newest created active legacy Support with configuration %j', async configuration => {
    fixture([independent, { ...legacy, id: 'older', created_at: 1 }, { ...legacy, configuration },
      { ...legacy, id: 'disabled', status: 'inactive', created_at: 4 },
      { ...legacy, id: 'sales', role: 'Sales', created_at: 3 }]);
    await expect(findActiveCustomerSupportAgent(site)).resolves.toEqual({ agentId: 'legacy', userId: 'legacy-owner' });
  },
);

it('does not enable text when only an active independent Support exists', async () => {
  fixture([independent, { ...legacy, status: 'inactive' }]);
  await expect(findActiveCustomerSupportAgent(site)).resolves.toBeNull();
});

it('email still requires exactly one legacy Support, regardless of status', async () => {
  const reads = fixture([independent, { ...legacy, status: 'inactive' }]);
  await expect(EmailProcessingService.findSupportAgent(site)).resolves.toBe('legacy');
  expect(reads[0].get('or')).toBe(legacyOr);
  fixture([independent]);
  await expect(EmailProcessingService.findSupportAgent(site)).rejects.toThrow();
  fixture([legacy, { ...legacy, id: 'another-legacy' }]);
  await expect(EmailProcessingService.findSupportAgent(site)).rejects.toThrow();
});

it.each([
  { row: legacy, lookups: 1 },
  { row: { ...legacy, role: 'Other', configuration: { role: support } }, lookups: 2 },
  { row: { ...legacy, role: 'Other' }, lookups: 3 },
])('Twilio retains its role/configuration/any-active fallback order: $lookups lookup(s)', async ({ row, lookups }) => {
  const reads = fixture([independent, row]);
  await expect(findWhatsAppConfiguration(phone)).resolves.toEqual({ success: true, siteId: site, agentId: 'legacy' });
  expect(reads).toHaveLength(lookups);
  for (const query of reads) expect(query.get('or')).toBe(legacyOr);
});

it('Twilio does not use an independent catch-all but still honors an existing token agent ID', async () => {
  fixture([independent]);
  await expect(findWhatsAppConfiguration(phone)).resolves.toMatchObject({ success: false });
  const reads = fixture([independent], 'assigned');
  await expect(findWhatsAppConfiguration(phone)).resolves.toEqual({ success: true, siteId: site, agentId: 'assigned' });
  expect(reads).toHaveLength(0);
});
