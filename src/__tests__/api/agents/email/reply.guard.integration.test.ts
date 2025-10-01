import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';

describe('Reply/LeadsReply/AliasReply guard integration (logic only)', () => {
  const emailConfig = {
    email: 'denis.cantu@comebien.mx',
    user: 'denis@comebien.mx',
    aliases: ['hola@comebien.mx']
  };
  const siteUrlDomain = 'https://comebien.mx';

  const inbound = (from: string, to: string, extra: Partial<any> = {}) => ({ from, to, ...extra });

  it('reply route would skip inbound from site domain', () => {
    const validEmails = [
      inbound('denis@comebien.mx', 'lead@ext.com'), // should skip
      inbound('lead@ext.com', 'hola@comebien.mx')   // should keep
    ];
    const res = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteUrlDomain });
    expect(res.skipped).toBe(1);
    expect(res.filtered).toHaveLength(1);
    expect(res.filtered[0].from).toBe('lead@ext.com');
  });

  it('leadsReply route would also skip inbound from site domain', () => {
    const validEmails = [
      inbound('ventas@comebien.mx', 'lead@x.com'),  // skip
      inbound('client@world.com', 'hola@comebien.mx') // keep
    ];
    const res = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteUrlDomain });
    expect(res.skipped).toBe(1);
    expect(res.filtered[0].from).toBe('client@world.com');
  });

  it('aliasReply route would skip when reply-to is site domain', () => {
    const validEmails = [
      inbound('customer@foo.com', 'hola@comebien.mx', { replyTo: 'denis.cantu@comebien.mx' }), // skip
      inbound('bar@vendor.com', 'hola@comebien.mx') // keep
    ];
    const res = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteUrlDomain });
    expect(res.skipped).toBe(1);
    expect(res.filtered).toHaveLength(1);
    expect(res.filtered[0].from).toBe('bar@vendor.com');
  });
});


