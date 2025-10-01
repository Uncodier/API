import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';

describe('SiteEmailGuardService - unit', () => {
  const emailConfig = {
    email: 'denis.cantu@comebien.mx',
    user: 'denis@comebien.mx',
    aliases: ['hola@comebien.mx', 'ventas@comebien.mx']
  };
  const siteUrlDomain = 'comebien.mx';

  const e = (from: string, to: string, extra: Partial<any> = {}) => ({ from, to, ...extra });

  test('extractFirstAddress parses common formats', () => {
    expect(SiteEmailGuardService.extractFirstAddress('Juan <a@b.com>')).toBe('a@b.com');
    expect(SiteEmailGuardService.extractFirstAddress('a@b.com')).toBe('a@b.com');
    expect(SiteEmailGuardService.extractFirstAddress('A <a@b.com>, C <c@d.com>')).toBe('a@b.com');
    expect(SiteEmailGuardService.extractFirstAddress(null)).toBeNull();
  });

  test('shouldSkipInboundBySiteDomain skips when from belongs to site addresses', () => {
    const email = e('denis@comebien.mx', 'osoto@networth.mx');
    const res = SiteEmailGuardService.shouldSkipInboundBySiteDomain(email, emailConfig, { siteUrlDomain });
    expect(res.skip).toBe(true);
    expect(res.reason).toMatch(/from-is-site-domain/);
  });

  test('shouldSkipInboundBySiteDomain skips when reply-to belongs to site domain', () => {
    const email = e('external@company.com', 'hola@comebien.mx', { replyTo: 'ventas@comebien.mx' });
    const res = SiteEmailGuardService.shouldSkipInboundBySiteDomain(email, emailConfig, { siteUrlDomain });
    expect(res.skip).toBe(true);
    expect(res.reason).toMatch(/reply-to-is-site-domain/);
  });

  test('should not skip when inbound is external → site alias', () => {
    const email = e('user@vendor.com', 'hola@comebien.mx');
    const res = SiteEmailGuardService.shouldSkipInboundBySiteDomain(email, emailConfig, { siteUrlDomain });
    expect(res.skip).toBe(false);
  });

  test('isSiteToExternal returns true for site → external', () => {
    const email = e('denis.cantu@comebien.mx', 'user@vendor.com');
    const res = SiteEmailGuardService.isSiteToExternal(email, emailConfig, { siteUrlDomain });
    expect(res.match).toBe(true);
  });

  test('isSiteToExternal returns false for site → site', () => {
    const email = e('denis@comebien.mx', 'hola@comebien.mx');
    const res = SiteEmailGuardService.isSiteToExternal(email, emailConfig, { siteUrlDomain });
    expect(res.match).toBe(false);
  });

  test('filterOutInboundFromSiteDomain removes site-origin messages', () => {
    const emails = [
      e('denis@comebien.mx', 'osoto@networth.mx'), // skip
      e('user@vendor.com', 'hola@comebien.mx'),    // keep
      e('client@x.com', 'ventas@comebien.mx', { replyTo: 'denis.cantu@comebien.mx' }) // skip by replyTo
    ];
    const res = SiteEmailGuardService.filterOutInboundFromSiteDomain(emails, emailConfig, { siteUrlDomain });
    expect(res.skipped).toBe(2);
    expect(res.filtered).toHaveLength(1);
    expect(res.filtered[0].from).toBe('user@vendor.com');
  });

  test('filterSiteToExternalSent keeps only site → external', () => {
    const emails = [
      e('denis@comebien.mx', 'lead@market.com'),     // keep
      e('ventas@comebien.mx', 'hola@comebien.mx'),    // drop site→site
      e('external@foo.com', 'lead@market.com'),       // drop external→external
      e('external@foo.com', 'ventas@comebien.mx')     // drop external→site
    ];
    const res = SiteEmailGuardService.filterSiteToExternalSent(emails, emailConfig, { siteUrlDomain });
    expect(res.sent).toHaveLength(1);
    expect(res.excluded).toBe(3);
    expect(res.sent[0].to).toBe('lead@market.com');
  });
});


