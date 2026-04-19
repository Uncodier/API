import type { DbLead } from '@/lib/database/lead-db';
import {
  buildMergeMapFromLead,
  normalizeMergeTokenSyntax,
  personalizeMergeTemplate,
  placeholderPolicyToMergePolicy,
} from './lead-merge-fields';

function sampleLead(overrides: Partial<DbLead> = {}): DbLead {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Jane Marie Doe',
    email: 'jane@example.com',
    personal_email: null,
    position: 'CTO',
    segment_id: null,
    status: 'new',
    notes: 'VIP',
    last_contact: null,
    site_id: '00000000-0000-4000-8000-000000000002',
    user_id: '00000000-0000-4000-8000-000000000003',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phone: '+15551234567',
    origin: null,
    social_networks: null,
    address: null,
    company: { name: 'Acme Inc' },
    subscription: null,
    birthday: null,
    campaign_id: null,
    command_id: null,
    language: null,
    company_id: null,
    attribution: null,
    metadata: { promo_code: 'SAVE10' },
    assignee_id: null,
    referral_lead_id: null,
    ...overrides,
  } as DbLead;
}

describe('normalizeMergeTokenSyntax', () => {
  it('lowercases and trims paths', () => {
    expect(normalizeMergeTokenSyntax('Hi {{ Lead.Name }}!')).toBe('Hi {{lead.name}}!');
  });

  it('maps aliases to canonical', () => {
    expect(normalizeMergeTokenSyntax('{{lead.full_name}} / {{lead.correo}}')).toBe(
      '{{lead.name}} / {{lead.email}}',
    );
  });

  it('leaves unknown paths lowercased', () => {
    expect(normalizeMergeTokenSyntax('{{lead.unknown_xyz}}')).toBe('{{lead.unknown_xyz}}');
  });
});

describe('buildMergeMapFromLead', () => {
  it('derives first_name from name', () => {
    const m = buildMergeMapFromLead(sampleLead(), 'My Site');
    expect(m['lead.first_name']).toBe('Jane');
    expect(m['lead.company']).toBe('Acme Inc');
    expect(m['site.name']).toBe('My Site');
  });

  it('handles company as string', () => {
    const m = buildMergeMapFromLead(sampleLead({ company: 'Plain Co' as unknown as DbLead['company'] }), undefined);
    expect(m['lead.company']).toBe('Plain Co');
  });
});

describe('personalizeMergeTemplate', () => {
  const lead = sampleLead();

  it('replaces known tokens', () => {
    const r = personalizeMergeTemplate('Hello {{lead.first_name}} at {{lead.company}}', lead, 'Site', 'strip_unresolved');
    expect(r.text).toBe('Hello Jane at Acme Inc');
    expect(r.aborted).toBe(false);
  });

  it('strips unknown tokens when policy strip', () => {
    const r = personalizeMergeTemplate('X {{lead.unknownfield}} Y', lead, 'Site', 'strip_unresolved');
    expect(r.text).toBe('X  Y');
    expect(r.aborted).toBe(false);
  });

  it('aborts on unknown token when policy skip', () => {
    const r = personalizeMergeTemplate('X {{lead.unknownfield}} Y', lead, 'Site', 'abort_if_unresolved');
    expect(r.aborted).toBe(true);
    expect(r.text).toBe('X {{lead.unknownfield}} Y');
    expect(r.unresolved.length).toBeGreaterThan(0);
  });

  it('resolves lead.metadata paths', () => {
    const r = personalizeMergeTemplate('Code {{lead.metadata.promo_code}}', lead, 'Site', 'strip_unresolved');
    expect(r.text).toBe('Code SAVE10');
  });

  it('maps placeholderPolicyToMergePolicy', () => {
    expect(placeholderPolicyToMergePolicy('strip_tokens')).toBe('strip_unresolved');
    expect(placeholderPolicyToMergePolicy('skip_recipient')).toBe('abort_if_unresolved');
    expect(placeholderPolicyToMergePolicy(undefined)).toBe('strip_unresolved');
  });
});
