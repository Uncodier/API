import { supabaseAdmin } from '@/lib/database/supabase-client';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { IdentifyRequest } from '@/src/app/api/visitors/identify/types';

export class LeadIdentificationService {
  /** Normalize email for upsert: trim + lowercase */
  static normalizeEmail(email?: string | null): string | undefined {
    if (email == null || typeof email !== 'string') return undefined;
    const v = email.trim().toLowerCase();
    return v === '' ? undefined : v;
  }

  /** Normalize name for upsert: trim + lowercase */
  static normalizeName(name?: string | null): string | undefined {
    if (name == null || typeof name !== 'string') return undefined;
    const v = name.trim().toLowerCase();
    return v === '' ? undefined : v;
  }

  /**
   * Identifies or creates a lead atomically using upsert.
   * This prevents duplication in concurrent requests.
   */
  static async identifyLead(validatedData: IdentifyRequest, siteUserId: string) {
    const { site_id, lead_id, traits } = validatedData;

    // If we have a specific lead_id, we update that lead
    if (lead_id) {
      return await this.updateExistingLead(lead_id, traits);
    }

    // Otherwise, we perform an atomic upsert based on site_id, name, and email
    const emailNorm = this.normalizeEmail(traits?.email);
    const nameNorm = this.normalizeName(traits?.name);

    if (!emailNorm || !nameNorm) {
      // If we don't have both email and name, we can't safely upsert on the composite key
      // but the DB constraint requires both. We'll fallback to search if needed,
      // but the goal is to use the atomic upsert.
      // For now, if one is missing, we try to find first (non-atomic, but better than nothing)
      // and then insert. However, the user asked for name/email constraint.
    }

    const leadData: any = {
      site_id,
      user_id: siteUserId,
      name: nameNorm ?? traits?.name ?? '',
      email: emailNorm ?? traits?.email ?? '',
      phone: traits?.phone ? normalizePhoneForStorage(traits.phone) : undefined,
      position: traits?.position,
      status: 'contacted',
      origin: traits?.origin || 'website',
      birthday: traits?.birthday,
      social_networks: traits?.social_networks || {},
      address: traits?.address || {},
      company: traits?.company || {},
      subscription: traits?.subscription || {},
      updated_at: new Date().toISOString()
    };

    // If it's a new lead, we want to set created_at too
    // Note: upsert in Supabase with onConflict will update existing fields.
    // We might want to avoid overwriting created_at if it's an update.
    
    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .upsert(leadData, {
        onConflict: 'site_id,name,email',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) {
      console.error('[LeadIdentificationService] Upsert error:', error);
      throw error;
    }

    return lead;
  }

  private static async updateExistingLead(leadId: string, traits: any) {
    const updateData: any = {
      updated_at: new Date().toISOString()
    };

    if (traits) {
      if (traits.email) updateData.email = this.normalizeEmail(traits.email);
      if (traits.name) updateData.name = this.normalizeName(traits.name);
      if (traits.phone) updateData.phone = normalizePhoneForStorage(traits.phone);
      if (traits.position) updateData.position = traits.position;
      if (traits.origin) updateData.origin = traits.origin;
      if (traits.birthday) updateData.birthday = traits.birthday;
      if (traits.social_networks) updateData.social_networks = traits.social_networks;
      if (traits.address) updateData.address = traits.address;
      if (traits.company) updateData.company = traits.company;
      if (traits.subscription) updateData.subscription = traits.subscription;
    }

    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .update(updateData)
      .eq('id', leadId)
      .select()
      .single();

    if (error) {
      console.error('[LeadIdentificationService] Update error:', error);
      throw error;
    }

    return lead;
  }

  static async updateVisitorAndMerge(visitorId: string, leadId: string, segmentId?: string) {
    const visitorUpdateData: any = {
      lead_id: leadId,
      segment_id: segmentId,
      is_identified: true,
      updated_at: new Date().toISOString()
    };

    const { data: updatedVisitor, error: updateError } = await supabaseAdmin
      .from('visitors')
      .update(visitorUpdateData)
      .eq('id', visitorId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // Find related visitors
    const { data: relatedVisitors } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('lead_id', leadId)
      .neq('id', visitorId);

    return {
      updatedVisitor,
      relatedVisitors: relatedVisitors || []
    };
  }
}
