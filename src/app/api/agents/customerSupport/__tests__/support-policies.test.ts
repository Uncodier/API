import { getCustomerSupportPolicies } from '../support-policies';

describe('getCustomerSupportPolicies', () => {
  const policies = getCustomerSupportPolicies();

  it('requires looking up the lead record before booking', () => {
    expect(policies).toContain('LEAD RECORD VERIFICATION');
    expect(policies).toContain('orders, appointments, reservations, and meeting tasks');
    expect(policies).toContain('do NOT create another');
  });

  it('treats later confirmation as not a new booking', () => {
    expect(policies).toContain('NEVER call scheduling.schedule or reservations.create again');
    expect(policies).toContain('scheduling action="update"');
    expect(policies).toContain('reservations.update');
  });
});
