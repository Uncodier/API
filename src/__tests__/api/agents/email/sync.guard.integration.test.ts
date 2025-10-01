import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';

describe('Sync guard classification (logic only)', () => {
  const emailConfig = {
    email: 'denis.cantu@comebien.mx',
    user: 'denis@comebien.mx',
    aliases: ['hola@comebien.mx', 'ventas@comebien.mx']
  };
  const siteUrlDomain = 'comebien.mx';

  const sent = (from: string, to: string) => ({ from, to });

  it('keeps only site→external as sent emails', () => {
    const emails = [
      sent('denis@comebien.mx', 'lead@vendor.com'), // keep
      sent('ventas@comebien.mx', 'hola@comebien.mx'), // drop (site→site)
      sent('ext@foo.com', 'lead@vendor.com'), // drop (ext→ext)
      sent('ext@foo.com', 'ventas@comebien.mx'), // drop (ext→site)
    ];
    const res = SiteEmailGuardService.filterSiteToExternalSent(emails, emailConfig, { siteUrlDomain });
    expect(res.sent).toHaveLength(1);
    expect(res.sent[0].to).toBe('lead@vendor.com');
    expect(res.excluded).toBe(3);
  });
});


