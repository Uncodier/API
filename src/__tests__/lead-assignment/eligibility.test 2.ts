import { isProfileEligibleForLeadAssignment } from '@/lib/services/lead-assignment/eligibility';

describe('isProfileEligibleForLeadAssignment', () => {
  it('allows explicit sales roles', () => {
    expect(isProfileEligibleForLeadAssignment({ id: 'u1', role: 'sales_agent', metadata: null })).toBe(true);
    expect(isProfileEligibleForLeadAssignment({ id: 'u2', role: 'sdr', metadata: null })).toBe(true);
    expect(isProfileEligibleForLeadAssignment({ id: 'u3', role: 'bdr', metadata: null })).toBe(true);
    expect(isProfileEligibleForLeadAssignment({ id: 'u4', role: 'vendedor', metadata: null })).toBe(true);
  });

  it('excludes external consultants by role keywords', () => {
    expect(isProfileEligibleForLeadAssignment({ id: 'e1', role: 'external_consultant', metadata: null })).toBe(false);
    expect(isProfileEligibleForLeadAssignment({ id: 'e2', role: 'consultor externo', metadata: null })).toBe(false);
    expect(isProfileEligibleForLeadAssignment({ id: 'e3', role: 'contractor', metadata: null })).toBe(false);
    expect(isProfileEligibleForLeadAssignment({ id: 'e4', role: 'freelancer', metadata: null })).toBe(false);
  });

  it('falls back to metadata when role is ambiguous', () => {
    expect(isProfileEligibleForLeadAssignment({ id: 'm1', role: 'member', metadata: { role: 'sdr' } })).toBe(true);
    expect(isProfileEligibleForLeadAssignment({ id: 'm2', role: 'member', metadata: { job_role: 'consultant externo' } })).toBe(false);
    expect(isProfileEligibleForLeadAssignment({ id: 'm3', role: 'admin', metadata: { title: 'contractor' } })).toBe(false);
  });

  it('defaults to false when insufficient sales signals', () => {
    expect(isProfileEligibleForLeadAssignment({ id: 'x1', role: 'member', metadata: {} })).toBe(false);
    expect(isProfileEligibleForLeadAssignment({ id: 'x2', role: null, metadata: null })).toBe(false);
    expect(isProfileEligibleForLeadAssignment(null as any)).toBe(false);
  });
});


