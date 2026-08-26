import { normalizeChannels, buildChannelFilterOrClause } from '../lead-channel-filters';

describe('Lead Channel Filters', () => {
  describe('normalizeChannels', () => {
    it('returns empty array when no channels provided', () => {
      expect(normalizeChannels()).toEqual([]);
      expect(normalizeChannels([])).toEqual([]);
    });

    it('normalizes supported channels', () => {
      expect(normalizeChannels(['Phone ', 'EMAIL', '  web'])).toEqual(['phone', 'email', 'web']);
    });

    it('maps website and website_chat to web', () => {
      expect(normalizeChannels(['website', 'website_chat', 'email'])).toEqual(['web', 'email']);
    });

    it('ignores unsupported channels', () => {
      expect(normalizeChannels(['phone', 'unknown', 'deals'])).toEqual(['phone', 'deals']);
    });

    it('removes duplicates', () => {
      expect(normalizeChannels(['phone', 'phone', 'web', 'website'])).toEqual(['phone', 'web']);
    });
  });

  describe('buildChannelFilterOrClause', () => {
    it('returns empty match=false when no channels provided', () => {
      expect(buildChannelFilterOrClause([], new Set())).toEqual({ orClause: null, isEmptyMatch: false });
    });

    it('builds OR clause for phone', () => {
      const result = buildChannelFilterOrClause(['phone'], new Set());
      expect(result.orClause).toBe('phone.neq.""');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('builds OR clause for email', () => {
      const result = buildChannelFilterOrClause(['email'], new Set());
      expect(result.orClause).toBe('email.neq.""');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('builds OR clause for web', () => {
      const result = buildChannelFilterOrClause(['web'], new Set());
      expect(result.orClause).toBe('company->>website.neq."",company->>domain.neq.""');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('builds combined OR clause for phone, email, web', () => {
      const result = buildChannelFilterOrClause(['phone', 'email', 'web'], new Set());
      expect(result.orClause).toBe('phone.neq."",email.neq."",company->>website.neq."",company->>domain.neq.""');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('builds OR clause for deals when dealLeadIds exist', () => {
      const dealLeads = new Set(['id1', 'id2']);
      const result = buildChannelFilterOrClause(['deals'], dealLeads);
      expect(result.orClause).toBe('id.in.(id1,id2)');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('returns emptyMatch=true when ONLY deals is requested but dealLeadIds is empty', () => {
      const result = buildChannelFilterOrClause(['deals'], new Set());
      expect(result.orClause).toBeNull();
      expect(result.isEmptyMatch).toBe(true);
    });

    it('ignores deals in OR clause when deals is requested alongside other channels but dealLeadIds is empty', () => {
      // If we ask for phone OR deals, and deals is empty, it should just return phone's clause
      const result = buildChannelFilterOrClause(['phone', 'deals'], new Set());
      expect(result.orClause).toBe('phone.neq.""');
      expect(result.isEmptyMatch).toBe(false);
    });

    it('combines all channels successfully', () => {
      const dealLeads = new Set(['id1']);
      const result = buildChannelFilterOrClause(['phone', 'email', 'web', 'deals'], dealLeads);
      expect(result.orClause).toBe('phone.neq."",email.neq."",company->>website.neq."",company->>domain.neq."",id.in.(id1)');
      expect(result.isEmptyMatch).toBe(false);
    });
  });
});
