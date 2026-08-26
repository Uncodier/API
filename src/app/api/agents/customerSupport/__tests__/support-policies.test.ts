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

  it('requires inferring a catalog search term instead of the raw user phrase', () => {
    expect(policies).toContain('Infer the search term');
    expect(policies).toContain('never the raw user phrase');
    expect(policies).toContain('korte de cabalero');
    expect(policies).toContain('search="corte"');
  });

  it('books catalog capacity via reservations.create then payment link, not a second create_order', () => {
    expect(policies).toContain('THEN reservations.create (creates the pending sale_order)');
    expect(policies).toContain('Do not also call checkout.create_order for that same slot');
    expect(policies).toContain('checkout.create_payment_link');
  });
});
