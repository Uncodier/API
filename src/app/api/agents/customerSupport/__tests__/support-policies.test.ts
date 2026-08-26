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

  it('requires looking up promotions before answering about discounts', () => {
    expect(policies).toContain('PROMOTIONS');
    expect(policies).toContain('promotions.list');
    expect(policies).toContain('Do not invent a promotion');
    expect(policies).toContain('Checkout does not apply promo codes');
  });

  it('requires catalog lookup for price questions and retry when list is empty', () => {
    expect(policies).toContain('price/cost');
    expect(policies).toContain('catalog_commerce action="list"');
    expect(policies).toContain('Do not use limit=1');
    expect(policies).toContain('retry immediately with a shorter term');
    expect(policies).toContain('never invent a price');
  });
});
