// Lazy import of supabase client only when needed to avoid requiring env during unit tests

type GuardDecision = { skip: boolean; reason?: string };

export class SiteEmailGuardService {
  /**
   * Extrae la primera dirección de email de un campo que puede contener
   * valores como "Nombre <correo@dominio>" o listas separadas por coma.
   */
  static extractFirstAddress(raw: any): string | null {
    if (!raw) return null;
    const value = String(raw).toLowerCase();
    const parts = value.split(',');
    const first = parts.length > 0 ? parts[0].trim() : value.trim();
    const match = first.match(/<([^>]+)>/);
    const email = (match ? match[1] : first).trim();
    return email.includes('@') ? email : null;
  }

  static getSiteAddresses(emailConfig: any): string[] {
    const addresses: string[] = [];
    const add = (v?: string) => {
      if (!v) return;
      const addr = this.extractFirstAddress(v);
      if (addr) addresses.push(addr);
    };
    add(emailConfig?.email);
    add(emailConfig?.user);

    const aliases = emailConfig?.aliases;
    if (Array.isArray(aliases)) {
      aliases.forEach(a => add(a));
    } else if (typeof aliases === 'string') {
      aliases
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .forEach(a => add(a));
    }

    return Array.from(new Set(addresses));
  }

  static deriveDomainsFromAddresses(addresses: string[]): Set<string> {
    const domains = new Set<string>();
    for (const a of addresses) {
      const parts = a.split('@');
      if (parts.length === 2) domains.add(parts[1]);
    }
    return domains;
  }

  static async getSiteUrlDomain(siteId?: string): Promise<string | null> {
    if (!siteId) return null;
    try {
      const { supabaseAdmin } = await import('@/lib/database/supabase-client');
      const { data, error } = await supabaseAdmin
        .from('sites')
        .select('url')
        .eq('id', siteId)
        .single();
      if (error || !data?.url) return null;
      try {
        const host = new URL(data.url).host.toLowerCase();
        // Tomar solo dominio raíz si viene con subdominio
        return host;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  static buildSiteDomains(emailConfig: any, siteUrlDomain?: string | null): Set<string> {
    const addresses = this.getSiteAddresses(emailConfig);
    const domains = this.deriveDomainsFromAddresses(addresses);
    if (siteUrlDomain) {
      const parts = siteUrlDomain.split(':')[0];
      const host = parts.toLowerCase();
      if (host.includes('.')) domains.add(host);
    }
    return domains;
  }

  /**
   * Decide si un email ENTRANTE debe saltarse por ser del mismo dominio del sitio.
   * Revisa `from` y `reply-to` (si existe) contra dominios/addresses del sitio.
   */
  static shouldSkipInboundBySiteDomain(
    email: any,
    emailConfig: any,
    opts?: { siteId?: string; siteUrlDomain?: string | null }
  ): GuardDecision {
    const fromAddr = this.extractFirstAddress(email?.from);
    const replyToAddr = this.extractFirstAddress(email?.replyTo || email?.['reply-to'] || email?.headers?.['reply-to']);

    const siteAddresses = new Set(this.getSiteAddresses(emailConfig));
    const siteDomains = this.buildSiteDomains(emailConfig, opts?.siteUrlDomain);

    const isAddressFromSite = (addr: string | null): boolean => {
      if (!addr) return false;
      if (siteAddresses.has(addr)) return true;
      const domain = addr.split('@')[1];
      return domain ? siteDomains.has(domain) : false;
    };

    if (isAddressFromSite(fromAddr)) {
      return { skip: true, reason: `from-is-site-domain (${fromAddr})` };
    }
    if (isAddressFromSite(replyToAddr)) {
      return { skip: true, reason: `reply-to-is-site-domain (${replyToAddr})` };
    }
    return { skip: false };
  }

  /**
   * Clasifica si un email corresponde a ENVIADO (site → externo).
   */
  static isSiteToExternal(
    email: any,
    emailConfig: any,
    opts?: { siteId?: string; siteUrlDomain?: string | null }
  ): { match: boolean; reason?: string } {
    const fromAddr = this.extractFirstAddress(email?.from);
    const toAddr = this.extractFirstAddress(email?.to);
    if (!fromAddr || !toAddr) return { match: false, reason: 'missing-address' };

    const siteAddresses = new Set(this.getSiteAddresses(emailConfig));
    const siteDomains = this.buildSiteDomains(emailConfig, opts?.siteUrlDomain);

    const fromDomain = fromAddr.split('@')[1];
    const toDomain = toAddr.split('@')[1];

    const fromIsSite = siteAddresses.has(fromAddr) || (fromDomain ? siteDomains.has(fromDomain) : false);
    const toIsSite = siteAddresses.has(toAddr) || (toDomain ? siteDomains.has(toDomain) : false);

    if (fromIsSite && !toIsSite) {
      return { match: true, reason: `site-to-external (${fromDomain} → ${toDomain})` };
    }
    return { match: false, reason: fromIsSite && toIsSite ? 'site-to-site' : 'external' };
  }

  static filterOutInboundFromSiteDomain(
    emails: any[],
    emailConfig: any,
    opts?: { siteId?: string; siteUrlDomain?: string | null }
  ): { filtered: any[]; skipped: number } {
    let skipped = 0;
    const filtered = emails.filter(e => {
      const decision = this.shouldSkipInboundBySiteDomain(e, emailConfig, opts);
      if (decision.skip) skipped++;
      return !decision.skip;
    });
    return { filtered, skipped };
  }

  static filterSiteToExternalSent(
    emails: any[],
    emailConfig: any,
    opts?: { siteId?: string; siteUrlDomain?: string | null }
  ): { sent: any[]; excluded: number } {
    let excluded = 0;
    const sent = emails.filter(e => {
      const res = this.isSiteToExternal(e, emailConfig, opts);
      if (!res.match) excluded++;
      return res.match;
    });
    return { sent, excluded };
  }
}


